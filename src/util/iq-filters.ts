/** IQ-domain replacements for radiom's audio-side cleanup filters.
 *
 *  These are pure functions that operate on complex baseband (I, Q
 *  Float32 arrays). They mirror the *intent* of the audio-path
 *  Passband / Notch / NB / DCK / NR but never touch the audio path —
 *  they exist so the SID classifier can run on a cleaned-up IQ stream
 *  without disturbing the operator's listening experience.
 *
 *  Conventions:
 *    • Sample rate is in Hz, frequencies are baseband-relative offsets
 *      from DC (signed). After SID's auto-centring the signal of
 *      interest sits at 0 Hz, so a "passband" is symmetric around DC.
 *    • All functions return NEW arrays — inputs are not mutated.
 *    • Each stage reports a small diagnostic (rejected dB, blanked
 *      fraction, etc.) so the SID report can show what happened.
 *
 *  Filter order applied by applyIqFilterChain (impulsive → bandlimit →
 *  tonal → broadband):
 *      NB  →  DCK  →  Passband + Notch  →  Spectral NR
 */

export interface IqPassbandOpts {
  /** Symmetric bandwidth around DC, Hz. Mirrors the audio low_cut /
   *  high_cut filter width. */
  bandwidthHz: number;
  /** Tukey-taper width as a fraction of the bandwidth (0 = brick wall,
   *  0.2 = 20 % cosine roll-off on each side). */
  tukey?: number;
}

export interface IqNotchOpts {
  /** Baseband-relative carrier offsets to notch out, Hz. */
  hzList: number[];
  /** Notch width, Hz (default 10). */
  widthHz?: number;
}

export interface IqNbOpts {
  /** Blanking threshold in robust-σ units (default 5). Samples whose
   *  |z| exceeds median(|z|) + thresholdSigma · MAD(|z|) are zeroed. */
  thresholdSigma?: number;
}

export interface IqDckOpts {
  /** Hampel window half-length (default 8 samples). */
  halfWindow?: number;
  /** Outlier threshold in MAD units (default 4). */
  sigmaThr?: number;
}

export interface IqNrOpts {
  /** STFT frame length, samples (default 1024). */
  frameLen?: number;
  /** Over-subtraction factor (default 1.4). > 1 cuts more aggressively. */
  overSub?: number;
  /** Floor gain (default 0.1) — prevents complete silence in suppressed
   *  bins, which would destroy phase/cumulant structure downstream. */
  floor?: number;
  /** Per-bin noise estimate is the `pctile` quantile of |X(k)|² across
   *  frames (default 0.25). MCRA-lite. */
  pctile?: number;
}

export interface IqFilterChainOpts {
  passband?: IqPassbandOpts | null;
  notches?:  IqNotchOpts    | null;
  nb?:       IqNbOpts       | null;
  dck?:      IqDckOpts      | null;
  nr?:       IqNrOpts       | null;
}

export interface IqFilterReport {
  /** Energy fraction (linear, post/pre) inside the passband after
   *  filtering — close to 1 if the operator's bandwidth contained the
   *  signal; small if most energy was out-of-band. */
  passbandKeptFrac: number;
  /** Out-of-band energy fraction (1 − keptFrac), in dB. */
  passbandRejectedDb: number;
  /** Notch offsets actually applied, Hz. */
  notchesAppliedHz: number[];
  /** Fraction of samples zeroed by NB. */
  nbBlankedFrac: number;
  /** Fraction of samples replaced by DCK Hampel. */
  dckReplacedFrac: number;
  /** Mean Wiener gain across in-band bins, dB (0 = no suppression). */
  nrAvgGainDb: number;
}

/* ─────────────────────────  FFT primitives  ─────────────────────── */

function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return p; }

/** In-place radix-2 Cooley-Tukey FFT. N must be a power of two. */
function fft(re: Float32Array, im: Float32Array): void {
  const N = re.length;
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
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < half; k++) {
        const tRe = cRe * re[i + k + half] - cIm * im[i + k + half];
        const tIm = cRe * im[i + k + half] + cIm * re[i + k + half];
        re[i + k + half] = re[i + k] - tRe;
        im[i + k + half] = im[i + k] - tIm;
        re[i + k] += tRe;
        im[i + k] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
}

function ifft(re: Float32Array, im: Float32Array): void {
  const N = re.length;
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / N;
  for (let i = 0; i < N; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
}

/* ─────────────────────────  helpers  ────────────────────────────── */

function medianAbs(x: Float32Array, sampleEvery = 1): number {
  const N = x.length;
  const buf: number[] = [];
  for (let i = 0; i < N; i += sampleEvery) buf.push(Math.abs(x[i]));
  buf.sort((a, b) => a - b);
  return buf[buf.length >> 1] || 0;
}

function copy(a: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  out.set(a);
  return out;
}

/* ─────────────────────────  Stage 1: NB  ────────────────────────── */

/** Magnitude-domain noise blanker. Replaces impulsive samples
 *  (|z| above median + k·MAD) with zero. This is the IQ analogue of
 *  Kiwi's `SET nb` server-side blanker. */
export function iqNoiseBlanker(
  I: Float32Array, Q: Float32Array, opts: IqNbOpts = {},
): { I: Float32Array; Q: Float32Array; blankedFrac: number } {
  const k = opts.thresholdSigma ?? 5;
  const N = I.length;
  // Robust threshold from a stride-sampled magnitude estimate.
  const stride = Math.max(1, Math.floor(N / 4096));
  const mags: number[] = [];
  for (let i = 0; i < N; i += stride) mags.push(Math.hypot(I[i], Q[i]));
  mags.sort((a, b) => a - b);
  const med = mags[mags.length >> 1] || 0;
  // MAD = median(|x − med|), then scale to σ via 1.4826.
  const dev = mags.map(v => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = dev[dev.length >> 1] || 0;
  const sigma = 1.4826 * mad;
  const thr = med + k * sigma;
  const Iout = copy(I), Qout = copy(Q);
  let blanked = 0;
  for (let i = 0; i < N; i++) {
    if (Math.hypot(I[i], Q[i]) > thr) { Iout[i] = 0; Qout[i] = 0; blanked++; }
  }
  return { I: Iout, Q: Qout, blankedFrac: blanked / N };
}

/* ─────────────────────────  Stage 2: DCK  ───────────────────────── */

/** Hampel de-clicker / sferic suppressor. Slides a window over |z|,
 *  flags samples where the centre deviates from the window median by
 *  more than sigmaThr · MAD, and replaces those samples (I and Q) with
 *  the window median amplitude carrying the original phase. */
export function iqHampelDeclick(
  I: Float32Array, Q: Float32Array, opts: IqDckOpts = {},
): { I: Float32Array; Q: Float32Array; replacedFrac: number } {
  const halfW = opts.halfWindow ?? 8;
  const k = opts.sigmaThr ?? 4;
  const N = I.length;
  const Iout = copy(I), Qout = copy(Q);
  const mag = new Float32Array(N);
  for (let i = 0; i < N; i++) mag[i] = Math.hypot(I[i], Q[i]);

  const w = 2 * halfW + 1;
  const window = new Float64Array(w);
  let replaced = 0;
  for (let i = halfW; i < N - halfW; i++) {
    for (let j = -halfW; j <= halfW; j++) window[j + halfW] = mag[i + j];
    const sorted = Array.from(window).sort((a, b) => a - b);
    const med = sorted[halfW];
    let sumDev = 0;
    const dev: number[] = [];
    for (let j = 0; j < w; j++) dev.push(Math.abs(window[j] - med));
    dev.sort((a, b) => a - b);
    const mad = dev[halfW];
    const sigma = 1.4826 * mad;
    if (sigma > 0 && Math.abs(mag[i] - med) > k * sigma) {
      // Scale (I, Q) so |z'| = med, preserving phase.
      const m = mag[i];
      if (m > 0) {
        const s = med / m;
        Iout[i] = I[i] * s;
        Qout[i] = Q[i] * s;
      }
      replaced++;
    }
    sumDev = 0; // touch to keep ts happy
    void sumDev;
  }
  return { I: Iout, Q: Qout, replacedFrac: replaced / N };
}

/* ──────────────  Stage 3: Passband + Notch (joint FFT)  ─────────── */

/** Single FFT, brick-wall passband mask with optional Tukey taper,
 *  plus per-frequency notches. Returns the time-domain complex signal
 *  after IFFT. */
export function iqPassbandNotch(
  I: Float32Array, Q: Float32Array, sampleRate: number,
  passband: IqPassbandOpts | null,
  notch: IqNotchOpts | null,
): { I: Float32Array; Q: Float32Array; keptFrac: number; notchesAppliedHz: number[] } {
  const N0 = I.length;
  if (!passband && !notch) {
    return { I: copy(I), Q: copy(Q), keptFrac: 1, notchesAppliedHz: [] };
  }
  const N = nextPow2(N0);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  re.set(I); im.set(Q);
  fft(re, im);
  const binHz = sampleRate / N;
  const half = N >> 1;

  // Build a multiplicative mask.
  const mask = new Float32Array(N);
  for (let k = 0; k < N; k++) mask[k] = 1;

  let beforeE = 0;
  for (let k = 0; k < N; k++) beforeE += re[k] * re[k] + im[k] * im[k];

  if (passband) {
    const bw = Math.max(1, passband.bandwidthHz);
    const tukey = Math.max(0, Math.min(0.5, passband.tukey ?? 0.1));
    const halfBwBins = (bw / 2) / binHz;
    const taperBins = Math.max(1, halfBwBins * tukey);
    for (let k = 0; k < N; k++) {
      // signed bin offset from DC: 0..half-1 → 0..(half-1), half..N-1 → −half..−1
      const sBin = k < half ? k : k - N;
      const f = Math.abs(sBin);
      if (f > halfBwBins) {
        mask[k] = 0;
      } else if (f > halfBwBins - taperBins) {
        // raised-cosine roll-off
        const t = (f - (halfBwBins - taperBins)) / taperBins;
        mask[k] *= 0.5 * (1 + Math.cos(Math.PI * t));
      }
    }
  }

  const notchesAppliedHz: number[] = [];
  if (notch) {
    const widthHz = notch.widthHz ?? 10;
    const widthBins = Math.max(1, Math.round(widthHz / binHz / 2));
    for (const hz of notch.hzList) {
      const targetBin = Math.round(hz / binHz);
      const k0 = ((targetBin % N) + N) % N;
      for (let d = -widthBins; d <= widthBins; d++) {
        const k = (((k0 + d) % N) + N) % N;
        mask[k] = 0;
      }
      notchesAppliedHz.push(hz);
    }
  }

  for (let k = 0; k < N; k++) { re[k] *= mask[k]; im[k] *= mask[k]; }

  let afterE = 0;
  for (let k = 0; k < N; k++) afterE += re[k] * re[k] + im[k] * im[k];

  ifft(re, im);
  const Iout = new Float32Array(N0), Qout = new Float32Array(N0);
  Iout.set(re.subarray(0, N0));
  Qout.set(im.subarray(0, N0));

  const keptFrac = beforeE > 0 ? afterE / beforeE : 1;
  return { I: Iout, Q: Qout, keptFrac, notchesAppliedHz };
}

/* ───────────────────  Stage 4: Spectral NR (Wiener)  ────────────── */

/** STFT-based Wiener spectral subtraction on complex baseband.
 *  Per-frequency noise PSD is estimated as the `pctile` quantile of
 *  |X(k,t)|² across frames (MCRA-lite). Wiener gain
 *      G(k,t) = max(floor, 1 − overSub · N(k) / |X(k,t)|²)
 *  is applied frame-by-frame, then overlap-added back. */
export function iqSpectralNR(
  I: Float32Array, Q: Float32Array, _sampleRate: number, opts: IqNrOpts = {},
): { I: Float32Array; Q: Float32Array; avgGainDb: number } {
  const N = opts.frameLen ?? 1024;
  const HOP = N >> 1;
  const overSub = opts.overSub ?? 1.4;
  const floor = opts.floor ?? 0.1;
  const pctile = opts.pctile ?? 0.25;
  const total = I.length;
  if (total < N) return { I: copy(I), Q: copy(Q), avgGainDb: 0 };

  // Hann window with COLA normalisation for 50 % overlap.
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  // For 50 % overlap Hann, Σ_n w[n]² over overlapping frames = 0.5 per
  // output sample; we'll divide by w-sum at the end.

  const nFrames = 1 + Math.floor((total - N) / HOP);

  // Pass 1: collect |X(k)|² per frame to estimate per-bin noise PSD.
  const powByBin: Float32Array[] = [];
  const reBuf = new Float32Array(N);
  const imBuf = new Float32Array(N);
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      reBuf[i] = I[off + i] * w[i];
      imBuf[i] = Q[off + i] * w[i];
    }
    fft(reBuf, imBuf);
    const p = new Float32Array(N);
    for (let k = 0; k < N; k++) p[k] = reBuf[k] * reBuf[k] + imBuf[k] * imBuf[k];
    powByBin.push(p);
  }
  const noisePsd = new Float32Array(N);
  const tmp: number[] = new Array(nFrames);
  for (let k = 0; k < N; k++) {
    for (let f = 0; f < nFrames; f++) tmp[f] = powByBin[f][k];
    tmp.sort((a, b) => a - b);
    noisePsd[k] = tmp[Math.floor(pctile * (nFrames - 1))];
  }

  // Pass 2: apply Wiener gain and overlap-add reconstruct.
  const Iout = new Float32Array(total);
  const Qout = new Float32Array(total);
  const wsum = new Float32Array(total);
  let gainSum = 0, gainN = 0;
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      reBuf[i] = I[off + i] * w[i];
      imBuf[i] = Q[off + i] * w[i];
    }
    fft(reBuf, imBuf);
    for (let k = 0; k < N; k++) {
      const pk = reBuf[k] * reBuf[k] + imBuf[k] * imBuf[k];
      const g = Math.max(floor, 1 - overSub * noisePsd[k] / Math.max(pk, 1e-20));
      reBuf[k] *= g;
      imBuf[k] *= g;
      gainSum += g; gainN++;
    }
    ifft(reBuf, imBuf);
    for (let i = 0; i < N; i++) {
      Iout[off + i] += reBuf[i] * w[i];
      Qout[off + i] += imBuf[i] * w[i];
      wsum[off + i] += w[i] * w[i];
    }
  }
  for (let i = 0; i < total; i++) {
    if (wsum[i] > 1e-9) { Iout[i] /= wsum[i]; Qout[i] /= wsum[i]; }
  }
  // Fill the un-windowed tail with the original samples so downstream
  // length-based features don't see a sudden zero region.
  for (let i = (nFrames - 1) * HOP + N; i < total; i++) {
    Iout[i] = I[i]; Qout[i] = Q[i];
  }
  const avgGain = gainN > 0 ? gainSum / gainN : 1;
  return { I: Iout, Q: Qout, avgGainDb: 20 * Math.log10(Math.max(avgGain, 1e-9)) };
}

/* ─────────────────────────  Chain  ──────────────────────────────── */

/** Run the full IQ-domain cleanup chain in the canonical order.
 *  Disable any stage by passing null for that key. */
export function applyIqFilterChain(
  I: Float32Array, Q: Float32Array, sampleRate: number,
  opts: IqFilterChainOpts,
): { I: Float32Array; Q: Float32Array; report: IqFilterReport } {
  let curI = I, curQ = Q;
  let blankedFrac = 0, replacedFrac = 0;
  let keptFrac = 1, notchesAppliedHz: number[] = [];
  let nrGainDb = 0;

  if (opts.nb) {
    const r = iqNoiseBlanker(curI, curQ, opts.nb);
    curI = r.I; curQ = r.Q; blankedFrac = r.blankedFrac;
  }
  if (opts.dck) {
    const r = iqHampelDeclick(curI, curQ, opts.dck);
    curI = r.I; curQ = r.Q; replacedFrac = r.replacedFrac;
  }
  if (opts.passband || opts.notches) {
    const r = iqPassbandNotch(curI, curQ, sampleRate,
      opts.passband ?? null, opts.notches ?? null);
    curI = r.I; curQ = r.Q;
    keptFrac = r.keptFrac;
    notchesAppliedHz = r.notchesAppliedHz;
  }
  if (opts.nr) {
    const r = iqSpectralNR(curI, curQ, sampleRate, opts.nr);
    curI = r.I; curQ = r.Q; nrGainDb = r.avgGainDb;
  }

  const rejectedDb = keptFrac > 0 ? 10 * Math.log10(Math.max(keptFrac, 1e-9)) : -90;
  return {
    I: curI, Q: curQ,
    report: {
      passbandKeptFrac: keptFrac,
      passbandRejectedDb: -rejectedDb,
      notchesAppliedHz,
      nbBlankedFrac: blankedFrac,
      dckReplacedFrac: replacedFrac,
      nrAvgGainDb: nrGainDb,
    },
  };
}

void medianAbs; // exported helper reserved for future use

/* ─────────────────────  Analytic signal (Hilbert)  ──────────────── */

/** Hilbert transform a real-valued mono audio signal into a complex
 *  analytic signal (I, Q). Used by the validator to feed audio test
 *  samples through the IQ classifier — gives the same complex baseband
 *  representation an IQ-mode Kiwi reception would produce. */
export function hilbertAnalytic(mono: Float32Array): { I: Float32Array; Q: Float32Array } {
  const L = mono.length;
  const N = nextPow2(L);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  re.set(mono);
  fft(re, im);
  // Analytic-signal construction: zero negative freqs, double positive freqs.
  const half = N >> 1;
  for (let k = 1; k < half; k++) { re[k] *= 2; im[k] *= 2; }
  for (let k = half + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
  ifft(re, im);
  const I = new Float32Array(L);
  const Q = new Float32Array(L);
  I.set(re.subarray(0, L));
  Q.set(im.subarray(0, L));
  return { I, Q };
}

