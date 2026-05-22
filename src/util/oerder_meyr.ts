// Non-data-aided symbol-rate + timing-phase estimator (Oerder & Meyr 1988).
//
// Applies a squaring-law nonlinearity to the complex baseband, then takes the
// FFT of |x|² and locates the cyclostationary spectral line at the symbol
// rate. A single complex value at that bin yields both the rate and the
// sub-sample timing phase, with no decisions, no carrier lock, and no prior
// knowledge of the modulation.
//
// Reference: M. Oerder, H. Meyr, "Digital filter and square timing recovery,"
// IEEE Trans. Commun., vol. 36, no. 5, pp. 605–612, May 1988.

/** In-place radix-2 Cooley-Tukey complex FFT. N must be a power of two. */
function fft(re: Float32Array, im: Float32Array): void {
  const N = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const ang = -2 * Math.PI / len;
    const wRe0 = Math.cos(ang), wIm0 = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let wRe = 1, wIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tRe = wRe * re[b] - wIm * im[b];
        const tIm = wRe * im[b] + wIm * re[b];
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe;        im[a] += tIm;
        const nRe = wRe * wRe0 - wIm * wIm0;
        wIm = wRe * wIm0 + wIm * wRe0;
        wRe = nRe;
      }
    }
  }
}

export interface OMResult {
  /** Estimated symbol rate, in samples-per-second of the input. */
  rs: number;
  /** Estimated sub-sample timing offset of the first symbol epoch, in
   *  samples. Range roughly [-sps/2, +sps/2). */
  tau: number;
  /** Peak-to-median ratio of the |Y(k)| line — a unitless confidence
   *  proxy. > ~6 is a usable lock; below that hold the previous estimate. */
  conf: number;
  /** Index of the peak bin (useful for debug / display). */
  peakBin: number;
  /** Which nonlinearity surfaced the line (`sq` = squaring law, `dm` =
   *  delay-and-multiply). Reported only by `estimateSymbolTimingBoth`. */
  kind?: 'sq' | 'dm';
}

export interface OMOpts {
  /** Sample rate of the complex baseband, Hz. */
  fs: number;
  /** Lower bound on plausible symbol rate, Hz. Defaults to 25 Hz. */
  minRs?: number;
  /** Upper bound on plausible symbol rate, Hz. Defaults to fs/2 - 100. */
  maxRs?: number;
  /** Nonlinearity. 'sq' = |x|² (good for linear modulations: PSK, QAM,
   *  RTTY-as-FSK after FM-discriminator). 'dm' = delay-and-multiply
   *  x[n]·conj(x[n-1]) (pulls the line up for narrowband MFSK / OOK / CW). */
  kind?: 'sq' | 'dm';
}

/** Estimate symbol rate and timing phase from an interleaved I/Q block.
 *
 *  The input MUST be a power-of-two number of complex samples. The caller
 *  is expected to accumulate a few thousand samples in a ring and pass a
 *  snapshot — at 12 kHz IQ, N=8192 gives ~1.5 Hz resolution and ~0.68 s
 *  update latency, which is the responsiveness sweet spot for a live
 *  constellation panel. */
export function estimateSymbolTiming(
  iq: Float32Array,
  opts: OMOpts,
): OMResult {
  const fs = opts.fs;
  const N = iq.length >> 1;
  if (N < 64 || (N & (N - 1)) !== 0) {
    throw new Error('estimateSymbolTiming: N must be a power of two >= 64');
  }
  const kind = opts.kind ?? 'sq';
  const minRs = opts.minRs ?? 25;
  const maxRs = opts.maxRs ?? (fs / 2 - 100);

  // Build the nonlinear signal y[n] (real).
  const yRe = new Float32Array(N);
  const yIm = new Float32Array(N);   // zero — FFT of a real signal
  if (kind === 'sq') {
    for (let n = 0; n < N; n++) {
      const I = iq[2 * n], Q = iq[2 * n + 1];
      yRe[n] = I * I + Q * Q;
    }
  } else {
    // Delay-and-multiply: y[n] = Re(x[n] * conj(x[n-1])) gives the IF tone
    // pattern that's strongest at the symbol-rate boundary for FSK-like
    // signals.
    let pRe = iq[0], pIm = iq[1];
    for (let n = 1; n < N; n++) {
      const I = iq[2 * n], Q = iq[2 * n + 1];
      // x[n] * conj(x[n-1]) = (I + jQ)(pRe - j pIm)
      const r = I * pRe + Q * pIm;
      // const i = Q * pRe - I * pIm;  // imag part unused
      yRe[n] = r;
      pRe = I; pIm = Q;
    }
    yRe[0] = yRe[1];  // copy to avoid the n=0 zero
  }

  // Remove DC (the squaring law produces a huge DC bias that would
  // otherwise dominate the FFT and force a wide guard band).
  let mean = 0;
  for (let n = 0; n < N; n++) mean += yRe[n];
  mean /= N;
  for (let n = 0; n < N; n++) yRe[n] -= mean;

  // Hann window to suppress sidelobes — the spectral line is narrow and we
  // care more about peak isolation than absolute amplitude.
  for (let n = 0; n < N; n++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
    yRe[n] *= w;
  }

  // FFT in place.
  fft(yRe, yIm);

  // Restrict the peak search to plausible symbol-rate bins. Because y is
  // real, only the first N/2 bins carry independent information.
  const kMin = Math.max(2, Math.floor((minRs * N) / fs));
  const kMax = Math.min((N >> 1) - 1, Math.floor((maxRs * N) / fs));

  const mag = new Float32Array(kMax - kMin + 1);
  for (let k = kMin; k <= kMax; k++) {
    const r = yRe[k], i = yIm[k];
    mag[k - kMin] = Math.sqrt(r * r + i * i);
  }

  // Locate peak.
  let kPeak = kMin, peak = 0;
  for (let k = kMin; k <= kMax; k++) {
    const m = mag[k - kMin];
    if (m > peak) { peak = m; kPeak = k; }
  }

  // Confidence = peak / median of the searched band.
  const sorted = Array.from(mag).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] || 1e-12;
  const conf = peak / median;

  // Sub-bin refinement via quadratic interpolation across the 3 bins
  // around the peak — tightens the rate estimate well below the bin width.
  let delta = 0;
  if (kPeak > kMin && kPeak < kMax) {
    const a = mag[kPeak - 1 - kMin];
    const b = mag[kPeak - kMin];
    const c = mag[kPeak + 1 - kMin];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) delta = 0.5 * (a - c) / denom;
  }
  const kRefined = kPeak + delta;
  const rs = (kRefined * fs) / N;

  // Timing phase from the complex bin value. Oerder-Meyr identity:
  //   τ = -(Tsym / 2π) · arg(Y[k_peak])
  // Expressed in samples of the input: τ_samp = -(N / (2π·k_peak)) · arg.
  // We use the integer-bin complex value (sub-bin phase wobble is small).
  const arg = Math.atan2(yIm[kPeak], yRe[kPeak]);
  const tau = -(N / (2 * Math.PI * kPeak)) * arg;

  return { rs, tau, conf, peakBin: kPeak };
}

/** Run both nonlinearity variants (`sq` and `dm`) and return whichever
 *  produced the higher peak-to-median ratio. Useful when the modulation is
 *  unknown: |x|² catches amplitude-varying signals (pulse-shaped PSK / QAM),
 *  while delay-and-multiply catches constant-envelope FSK / MFSK / rectangular
 *  BPSK. */
export function estimateSymbolTimingBoth(
  iq: Float32Array,
  opts: OMOpts,
): OMResult {
  const sq = estimateSymbolTiming(iq, { ...opts, kind: 'sq' });
  const dm = estimateSymbolTiming(iq, { ...opts, kind: 'dm' });
  const winner = dm.conf > sq.conf ? dm : sq;
  return { ...winner, kind: dm.conf > sq.conf ? 'dm' : 'sq' };
}
