// Convert a real mono audio stream into a complex baseband suitable for
// constellation plotting.
//
// Pipeline per input chunk:
//   1. Quadrature mix the audio against a user-chosen center frequency `f0`
//      via an NCO. The mixer output is the complex baseband:
//        I[n] = audio[n] * cos(2π f0 n / fs)
//        Q[n] = audio[n] * -sin(2π f0 n / fs)
//   2. Symmetric FIR low-pass on I and Q with cutoff = bandwidth/2.
//      Suppresses the upper image (at 2·f0) and any neighbouring carriers.
//   3. Decimate by an integer factor so the output rate is just barely
//      above 2·bandwidth (Nyquist on the post-LPF spectrum) — keeps the
//      constellation panel from being flooded with samples while losing
//      no information.
//   4. Emit as a Uint8Array of interleaved big-endian int16 I/Q — bit-
//      identical to the format the existing IQ View canvas consumes —
//      so all of the downstream machinery (peak-hold normalisation,
//      Oerder-Meyr AUTO, MM clock recovery, persistence rendering)
//      "just works" with audio as the source.
//
// The NCO uses an incremental phasor (rotate by `e^(jω)` per sample) to
// avoid `Math.sin/cos` in the hot loop, and the FIR uses a per-instance
// ring buffer so state carries across chunks without a copy.

export type CostasMode = 'bpsk' | 'qpsk' | '8psk' | 'fsk';

export interface AudioConstellationOpts {
  /** Input sample rate of the mono audio, Hz. Kiwi audio is 12 kHz. */
  sampleRate: number;
  /** Mixer carrier frequency, Hz. Should be the audio-domain centre of
   *  the signal under inspection (e.g. 1500 Hz for a USB-demodulated
   *  signal whose RF carrier is 1.5 kHz above the dial). */
  centerHz: number;
  /** Post-mix low-pass cutoff (total signal bandwidth), Hz. Set to roughly
   *  2× the symbol rate for clean eyes; e.g. ~125 Hz for PSK31, ~1000 Hz
   *  for PSK500. */
  bandwidthHz: number;
  /** When true, apply a Costas loop to the output: an additional phase
   *  rotation that locks onto the suppressed carrier, removing residual
   *  frequency offset and stabilising the constellation. */
  costas?: boolean;
  /** Constellation order — drives which Costas phase detector is used.
   *  'bpsk' (default) uses sign(I)·Q, suitable for ±1 BPSK.
   *  'qpsk' uses sign(I)·Q − sign(Q)·I, suitable for 4-PSK.
   *  '8psk' uses sin(8·arg(x)), suitable for 8-PSK. */
  costasMode?: CostasMode;
  /** Sink for the resulting complex baseband, packed as interleaved
   *  big-endian int16 I/Q — the same wire format the Kiwi IQ stream uses. */
  onIq: (bytes: Uint8Array) => void;
}

export class AudioConstellation {
  private fs: number;
  private centerHz: number;
  private bandwidthHz: number;
  private onIq: (b: Uint8Array) => void;

  // NCO phasor (cos, sin); rotated by (cosStep, -sinStep) per sample so the
  // mixer is sin(2π·f0·n/fs) without per-sample trig calls.
  private oscCos = 1;
  private oscSin = 0;
  private cosStep = 1;
  private sinStep = 0;

  // FIR taps for the LPF and shared delay lines for I and Q.
  private taps: Float32Array = new Float32Array(1);
  private histI: Float32Array = new Float32Array(1);
  private histQ: Float32Array = new Float32Array(1);
  private histW = 0;

  // Decimation: keep one out of every `dec` post-filter samples. Counter
  // carries across chunks.
  private dec = 1;
  private decCount = 0;

  // Output scratch (reused across calls).
  private outScratch = new Uint8Array(0);

  // ── Costas loop (post-decimation, output-rate) ──
  // Removes residual carrier offset from the constellation. The mixer
  // gets the input close to baseband; the Costas loop polishes off any
  // remaining frequency / phase error using a constellation-order-
  // specific nonlinearity that cancels the symbol modulation. Convergence:
  // a few hundred output samples, ~0.1–0.3 s on typical audio.
  private costasOn = false;
  private costasMode: CostasMode = 'bpsk';
  private costasTheta = 0;     // accumulated phase (rad)
  private costasOmega = 0;     // tracked frequency offset (rad / output sample)
  private readonly costasKp = 0.04;
  private readonly costasKi = 0.0004;
  // FSK-mode state. For 2-FSK / MFSK, the centroid-PLL approach fails
  // for asymmetric content (RTTY idle = mark-only → centroid follows
  // mark, then jumps when data starts). Instead we run a periodic FFT
  // on the raw audio, find the strongest tone in the passband, and
  // shift our output by the offset between that tone and `centerHz`.
  // For RTTY this naturally pins mark to DC; space then traces a single
  // clean circle at the shift frequency.
  private fskFftRing = new Float32Array(2048);  // ~170 ms at 12 kHz
  private fskFftW = 0;
  private fskFftFilled = 0;
  private fskFftSinceLast = 0;
  // Active de-rotation: incremental phasor rotated per OUTPUT sample by
  // the current offset. When the FFT picks a new peak, `fskStep{Cos,Sin}`
  // is recomputed; `fskRot{Cos,Sin}` walks continuously so the
  // constellation doesn't jump when the peak estimate updates.
  private fskRotCos = 1;
  private fskRotSin = 0;
  private fskStepCos = 1;
  private fskStepSin = 0;
  private fskSmoothedPeakHz: number | null = null;

  constructor(opts: AudioConstellationOpts) {
    this.fs = opts.sampleRate;
    this.centerHz = opts.centerHz;
    this.bandwidthHz = opts.bandwidthHz;
    this.costasOn = !!opts.costas;
    this.costasMode = opts.costasMode ?? 'bpsk';
    this.onIq = opts.onIq;
    this.rebuildFilter();
    this.rebuildOsc();
  }

  setCostas(on: boolean) {
    if (on === this.costasOn) return;
    this.costasOn = on;
    this.costasTheta = 0;
    this.costasOmega = 0;
  }

  setCostasMode(mode: CostasMode) {
    if (mode === this.costasMode) return;
    this.costasMode = mode;
    // Reset loop state — the error surface is different per mode, so
    // restart cleanly to avoid converging from a poor initial guess.
    this.costasTheta = 0;
    this.costasOmega = 0;
    this.fskFftW = 0;
    this.fskFftFilled = 0;
    this.fskFftSinceLast = 0;
    this.fskRotCos = 1; this.fskRotSin = 0;
    this.fskStepCos = 1; this.fskStepSin = 0;
    this.fskSmoothedPeakHz = null;
  }

  setCenter(hz: number) {
    if (!Number.isFinite(hz) || hz < 0 || hz > this.fs / 2) return;
    this.centerHz = hz;
    this.rebuildOsc();
    // Don't reset the phasor — let the constellation rotate through to
    // the new center smoothly.
  }

  setBandwidth(hz: number) {
    if (!Number.isFinite(hz) || hz <= 0 || hz > this.fs / 2) return;
    this.bandwidthHz = hz;
    this.rebuildFilter();
  }

  feed(audio: Int16Array): void {
    const n = audio.length;
    if (n === 0) return;
    const taps = this.taps;
    const M = taps.length;
    const histI = this.histI, histQ = this.histQ;

    // Worst-case output: every input sample survives decimation.
    const outNeed = Math.ceil(n / this.dec) * 4;
    if (this.outScratch.length < outNeed) this.outScratch = new Uint8Array(outNeed);
    const out = this.outScratch;
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let outBytes = 0;

    // FSK mode runs a periodic FFT on the raw audio to find the
    // strongest tone and pin it to DC at the output stage.
    const fftCap = this.fskFftRing.length;
    for (let i = 0; i < n; i++) {
      // Normalise input to [-1, 1) for stable LPF dynamic range.
      const s = audio[i] / 32768;

      // Feed the FSK FFT ring (cheap; only used when costas+fsk active).
      if (this.costasOn && this.costasMode === 'fsk') {
        this.fskFftRing[this.fskFftW] = s;
        this.fskFftW = (this.fskFftW + 1) % fftCap;
        if (this.fskFftFilled < fftCap) this.fskFftFilled++;
        this.fskFftSinceLast++;
        // Re-estimate every ~85 ms (1024 audio samples at 12 kHz) once
        // the ring is full.
        if (this.fskFftFilled >= fftCap && this.fskFftSinceLast >= 1024) {
          this.fskFftSinceLast = 0;
          this.updateFskRotationFromPeak();
        }
      }

      // Quadrature mix.
      const I0 = s * this.oscCos;
      const Q0 = -s * this.oscSin;

      // Rotate the phasor by one step: (c', s') = (c·cs - s·ss, c·ss + s·cs).
      const c = this.oscCos, sn = this.oscSin;
      this.oscCos = c * this.cosStep - sn * this.sinStep;
      this.oscSin = c * this.sinStep + sn * this.cosStep;

      // Push into the FIR delay lines, then advance the write pointer.
      histI[this.histW] = I0;
      histQ[this.histW] = Q0;
      this.histW = this.histW + 1;
      if (this.histW >= M) this.histW = 0;

      // Decimate. Only compute the FIR at the kept samples — running it
      // on every input is `dec`-times more work for output that gets
      // discarded anyway. With dec=8 this is the 8× speed-up that lets
      // the bridge keep up with real-time fan-out from GEN.
      if (++this.decCount >= this.dec) {
        this.decCount = 0;
        let accI = 0, accQ = 0;
        let h = this.histW - 1;
        if (h < 0) h += M;
        for (let k = 0; k < M; k++) {
          accI += taps[k] * histI[h];
          accQ += taps[k] * histQ[h];
          h = h - 1;
          if (h < 0) h = M - 1;   // branchless-ish, no integer mod
        }
        // Costas loop. Apply the current loop phase as an additional
        // rotation, then derive an order-appropriate phase error and
        // feed a 2nd-order loop (proportional + integral) back into the
        // phase accumulator.
        if (this.costasOn) {
          const c = Math.cos(this.costasTheta), sn = Math.sin(this.costasTheta);
          const Ir =  accI * c + accQ * sn;
          const Qr = -accI * sn + accQ * c;
          let err: number;
          // Per-mode loop gain. Higher-order detectors have a steeper
          // error slope near lock, so they need lower gain to avoid
          // over-correcting noise into a wider final jitter.
          let kp = this.costasKp, ki = this.costasKi;
          switch (this.costasMode) {
            case 'qpsk':
              // sign(I)·Q − sign(Q)·I — the cross-coupled hard-decision
              // detector for 4-PSK. Vanishes when the signal aligns to
              // either I or Q axis. Same loop gain as BPSK (the detector
              // has comparable slope to sign(I)·Q near lock).
              err = (Ir >= 0 ? 1 : -1) * Qr - (Qr >= 0 ? 1 : -1) * Ir;
              break;
            case '8psk':
              // sin(8·arg(x)): the M=8 M-PSK detector. Zero when phase is
              // a multiple of π/4 (any of the 8 constellation points).
              err = Math.sin(8 * Math.atan2(Qr, Ir));
              kp *= 0.25;
              ki *= 0.25;
              break;
            case 'fsk':
              // FSK / MFSK lock is handled by spectral-peak snap (see
              // updateFskRotationFromPeak). The Costas PLL is bypassed
              // here; we skip ahead and apply fskRot{Cos,Sin} below.
              err = 0;
              break;
            case 'bpsk':
            default:
              // sign(I)·Q — classic BPSK Costas error.
              err = (Ir >= 0 ? 1 : -1) * Qr;
              break;
          }
          // Per-mode clamp to bound transients. FSK's atan2 detector
          // already returned values in (-π, π], so don't clip it down
          // to ±0.5 — that would saturate the mark and space symbols
          // symmetrically and kill the centroid error signal. PSK
          // detectors get the standard ±0.5 clip.
          if (this.costasMode !== 'fsk') {
            if (err > 0.5) err = 0.5; else if (err < -0.5) err = -0.5;
          }
          this.costasOmega += ki * err;
          this.costasTheta += this.costasOmega + kp * err;
          // Keep theta in (-π, π] so the trig stays well-conditioned.
          if (this.costasTheta > Math.PI) this.costasTheta -= 2 * Math.PI;
          else if (this.costasTheta < -Math.PI) this.costasTheta += 2 * Math.PI;
          accI = Ir; accQ = Qr;
        }
        // FSK-mode rotation: pin the spectral peak (computed by the
        // periodic FFT above) to DC. Runs AFTER the Costas block since
        // that block left accI/accQ untouched for FSK.
        if (this.costasOn && this.costasMode === 'fsk') {
          const c = this.fskRotCos, s = this.fskRotSin;
          const Ir =  accI * c + accQ * s;
          const Qr = -accI * s + accQ * c;
          accI = Ir; accQ = Qr;
          // Advance the rotation phasor by one output step.
          const nc = c * this.fskStepCos - s * this.fskStepSin;
          const ns = c * this.fskStepSin + s * this.fskStepCos;
          // Keep on the unit circle (per-block re-norm at end of feed).
          this.fskRotCos = nc; this.fskRotSin = ns;
        }
        // Scale back up into int16. The LPF preserves amplitude (DC gain 1)
        // but we want some headroom since the constellation panel does its
        // own peak-hold normalisation downstream.
        const I16 = Math.max(-32768, Math.min(32767, (accI * 16384) | 0));
        const Q16 = Math.max(-32768, Math.min(32767, (accQ * 16384) | 0));
        dv.setInt16(outBytes,     I16, false);
        dv.setInt16(outBytes + 2, Q16, false);
        outBytes += 4;
      }
    }

    // Re-keep the phasor on the unit circle. Floating-point error from
    // the incremental rotation grows like O(√n); normalising every chunk
    // keeps it bounded forever.
    const mag = Math.hypot(this.oscCos, this.oscSin);
    if (mag > 0) {
      this.oscCos /= mag;
      this.oscSin /= mag;
    }
    // Same per-chunk renorm for the FSK rotation phasor.
    if (this.costasOn && this.costasMode === 'fsk') {
      const m = Math.hypot(this.fskRotCos, this.fskRotSin);
      if (m > 0) { this.fskRotCos /= m; this.fskRotSin /= m; }
    }

    if (outBytes > 0) this.onIq(out.subarray(0, outBytes));
  }

  /** Run a Hann-windowed real FFT on the FSK ring, find the strongest
   *  bin in the passband (centerHz ± bandwidthHz/2), and update the
   *  output-side rotation step so the bridge de-rotates by that peak's
   *  offset from centerHz. Result: the peak tone is pinned to DC. */
  private updateFskRotationFromPeak(): void {
    const N = this.fskFftRing.length;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    // Unwrap the ring (oldest sample first).
    const head = this.fskFftW;
    for (let i = 0; i < N; i++) {
      const src = this.fskFftRing[(head + i) % N];
      // Hann window.
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = src * w;
    }
    // In-place radix-2 Cooley-Tukey FFT.
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
    // Build power spectrum within the passband.
    const fs = this.fs;
    const half = this.bandwidthHz / 2;
    const minHz = Math.max(50, this.centerHz - half);
    const maxHz = Math.min(fs / 2 - 50, this.centerHz + half);
    const minBin = Math.max(1, Math.floor((minHz * N) / fs));
    const maxBin = Math.min((N >> 1) - 1, Math.floor((maxHz * N) / fs));
    const power = new Float32Array(maxBin - minBin + 1);
    for (let k = minBin; k <= maxBin; k++) {
      power[k - minBin] = re[k] * re[k] + im[k] * im[k];
    }
    // For FSK we want a STABLE estimate of the tone bank centre, not the
    // single strongest tone (which alternates between mark and space
    // depending on what's being keyed at the moment) and not the
    // instantaneous power centroid (which leans toward whatever was
    // dominant in this 170 ms window — e.g. always mark during RTTY
    // idle). Take the midpoint of the LOWEST and HIGHEST significant
    // bins (threshold = max × 0.4). For clean 2-FSK this is exactly the
    // mark+space midpoint regardless of duty cycle.
    let maxP = 0;
    for (let k = 0; k < power.length; k++) if (power[k] > maxP) maxP = power[k];
    if (maxP < 1e-9) return;
    const threshold = maxP * 0.4;
    let loBin = -1, hiBin = -1;
    for (let k = 0; k < power.length; k++) {
      if (power[k] > threshold) {
        if (loBin < 0) loBin = k;
        hiBin = k;
      }
    }
    if (loBin < 0) return;
    const loHz = (loBin + minBin) * fs / N;
    const hiHz = (hiBin + minBin) * fs / N;
    // For RTTY-class signals, idle stretches show only ONE tone above
    // threshold — using the lo+hi midpoint then collapses to that tone,
    // which then jumps when the other tone appears. To avoid the jump,
    // require a minimum separation (loHz and hiHz must be at least
    // ~50 Hz apart). Otherwise, hold the previous estimate so the
    // lock doesn't track an idle-only tone.
    if (hiHz - loHz < 50) return;
    const peakHz = (loHz + hiHz) / 2;
    // Smooth the estimate via a slow IIR — multiple FFT updates iron
    // out single-window jitter from short-burst content.
    if (this.fskSmoothedPeakHz == null) this.fskSmoothedPeakHz = peakHz;
    else this.fskSmoothedPeakHz = 0.7 * this.fskSmoothedPeakHz + 0.3 * peakHz;
    const offsetHz = this.fskSmoothedPeakHz - this.centerHz;
    // De-rotate the bridge output by `offsetHz` (i.e. rotate by -offsetHz)
    // per OUTPUT sample. Output rate = fs / dec.
    const outRate = fs / this.dec;
    const stepRad = -2 * Math.PI * offsetHz / outRate;
    this.fskStepCos = Math.cos(stepRad);
    this.fskStepSin = Math.sin(stepRad);
  }

  /** Reset the FIR delay line and decimation counter. Useful after a long
   *  pause to avoid playing back stale samples when reopening the panel. */
  reset() {
    this.histI.fill(0);
    this.histQ.fill(0);
    this.histW = 0;
    this.decCount = 0;
  }

  private rebuildOsc() {
    const ω = (2 * Math.PI * this.centerHz) / this.fs;
    this.cosStep = Math.cos(ω);
    this.sinStep = Math.sin(ω);
  }

  private rebuildFilter() {
    // Windowed-sinc FIR design. Transition band ≈ fs/M; pick M so it's
    // a few times tighter than the bandwidth we're targeting, but cap it
    // so the per-sample convolution doesn't run away.
    const cutoff = this.bandwidthHz / 2;        // single-sided lowpass cutoff
    const transition = Math.max(50, cutoff * 0.5);
    const M = Math.min(257, Math.max(33, ((this.fs / transition) | 0) | 1)); // odd
    const taps = new Float32Array(M);
    const fc = cutoff / this.fs;                // normalised cutoff
    const half = (M - 1) / 2;
    let sum = 0;
    for (let k = 0; k < M; k++) {
      const x = k - half;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      // Blackman window — good stop-band rejection (~74 dB), modest main lobe.
      const w =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * k) / (M - 1)) +
        0.08 * Math.cos((4 * Math.PI * k) / (M - 1));
      taps[k] = sinc * w;
      sum += taps[k];
    }
    // DC-normalise so passband gain is unity.
    if (sum !== 0) for (let k = 0; k < M; k++) taps[k] /= sum;
    this.taps = taps;
    this.histI = new Float32Array(M);
    this.histQ = new Float32Array(M);
    this.histW = 0;

    // Choose decimation so output rate is at least 2.5× bandwidth, which
    // leaves comfortable margin for the constellation panel. Cap so we
    // always emit at least a few hundred samples per chunk.
    const minOutRate = Math.max(1500, this.bandwidthHz * 2.5);
    this.dec = Math.max(1, Math.floor(this.fs / minOutRate));
    this.decCount = 0;
  }
}
