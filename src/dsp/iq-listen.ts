/** IqListenDemod — client-side IQ→audio demodulator for sources that
 *  don't provide server-side audio (Airspy SpyServer, rtl_tcp).
 *
 *  Channel filtering is done by **FFT-based fast convolution**: the
 *  same approach SDR# and most professional SDR clients use under the
 *  hood. A 1024-point FFT at 24 kHz IQ rate gives 23 Hz resolution
 *  per bin — equivalent to a roughly 1000-tap FIR filter with
 *  brick-wall transitions and near-zero passband ripple. The 4-pole
 *  Butterworth IIR I tried in v0.4.53 was too soft for SDR work
 *  (24 dB/octave skirts let in too much adjacent-channel energy).
 *
 *  Pipeline per 1024-sample analysis block (50 % Hann overlap-add):
 *    1. Decode int16 BE IQ → Float32 complex
 *    2. FFT
 *    3. Mask: zero bins outside the passband AND (for SSB) zero the
 *       unwanted sideband
 *    4. IFFT (complex output stays complex)
 *    5. Per-mode demod:
 *         AM    → envelope of complex output, DC-blocked
 *         USB/CW/SAU → real part (positive-freq mask kept USB)
 *         LSB/SAL    → real part of conjugated IQ (Q→-Q flips spectrum)
 *         NBFM  → discriminator (I·Q' − Q·I') / (I² + Q²)
 *    6. Integer decimation to output rate
 *    7. Audio scratch → int16 BE PCM → onAudio(payload)
 *
 *  Frames are emitted as soon as audioOut fills (~50 ms at outputRate)
 *  so the player gets continuous chunks without burst gaps.
 */

export type ListenMode = 'am' | 'sam' | 'sal' | 'sau' | 'usb' | 'lsb' | 'cw' | 'nbfm';

export interface IqListenOpts {
  inputRate: number;
  outputRate?: number;
  mode?: ListenMode;
  lowCutHz?: number;
  highCutHz?: number;
  gain?: number;
}

const N = 1024;
const HOP = N >> 1;

function makeHann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
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
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
}

export class IqListenDemod {
  private inputRate: number;
  private outputRate: number;
  private mode: ListenMode;
  private lowCutHz: number;
  private highCutHz: number;
  private gain: number;

  private bufRe = new Float32Array(N * 2);
  private bufIm = new Float32Array(N * 2);
  private bufFill = 0;
  /** OLA tail — the second half of the previous IFFT result, added
   *  into the first half of the new IFFT to reconstruct without
   *  block-boundary discontinuities. */
  private olaTailRe = new Float32Array(HOP);
  private olaTailIm = new Float32Array(HOP);

  private window: Float32Array;
  private fftRe = new Float32Array(N);
  private fftIm = new Float32Array(N);

  /** Mask LUT — keepMask[k] is 1 if bin k passes the filter, 0 if it's
   *  zeroed. Recomputed any time mode / passband / rate changes. */
  private keepMask = new Uint8Array(N);

  private decim: number;
  private decimPhase = 0;

  private audioOut: Float32Array;
  private audioOutFill = 0;

  private amDc = 0;
  private fmPrevI = 0;
  private fmPrevQ = 0;

  onAudio: ((bytes: Uint8Array) => void) | null = null;

  constructor(opts: IqListenOpts) {
    this.inputRate  = opts.inputRate;
    this.outputRate = opts.outputRate ?? 12000;
    this.mode       = opts.mode ?? 'usb';
    this.lowCutHz   = opts.lowCutHz ?? 0;
    this.highCutHz  = opts.highCutHz ?? 3000;
    // Gain compensates for the COLA = 0.5 of the double-windowed Hann
    // overlap-add reconstruction. ×2 brings the signal back to unity;
    // a bit of extra headroom (×1.5) keeps int16 from clipping on peaks.
    this.gain       = opts.gain ?? 3.0;

    this.window = makeHann(N);
    this.decim = Math.max(1, Math.round(this.inputRate / this.outputRate));
    this.audioOut = new Float32Array(Math.max(64, Math.round(this.outputRate * 0.05)));
    this.computeMask();
  }

  setMode(mode: ListenMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.amDc = 0; this.fmPrevI = 0; this.fmPrevQ = 0;
    this.computeMask();
  }

  setPassband(lowHz: number, highHz: number): void {
    if (lowHz === this.lowCutHz && highHz === this.highCutHz) return;
    this.lowCutHz = lowHz;
    this.highCutHz = highHz;
    this.computeMask();
  }

  setInputRate(rate: number): void {
    if (rate === this.inputRate) return;
    this.inputRate = rate;
    this.decim = Math.max(1, Math.round(this.inputRate / this.outputRate));
    this.computeMask();
  }

  getEffectiveOutputRate(): number {
    return Math.max(1, Math.round(this.inputRate / this.decim));
  }

  /** Build keepMask from current mode + passband + rate. Sharp brick-
   *  wall filter — each bin is binary kept/zeroed. */
  private computeMask(): void {
    const binHz = this.inputRate / N;
    const half = N >> 1;
    const lo = this.lowCutHz, hi = this.highCutHz;
    const mode = this.mode;
    const aLo = Math.abs(lo), aHi = Math.abs(hi);
    const passLo = Math.min(aLo, aHi);
    const passHi = Math.max(aLo, aHi);
    for (let k = 0; k < N; k++) {
      const f = k < half ? k * binHz : (k - N) * binHz;
      let keep = 1;
      // Sideband selection — for SSB the passband is asymmetric.
      // The LSB path conjugates Q in feed() so its desired audio sits
      // in the positive baseband, hence treated the same as USB here.
      if (mode === 'usb' || mode === 'sau' || mode === 'cw' ||
          mode === 'lsb' || mode === 'sal') {
        if (f <= 0) keep = 0;
      }
      // Passband (symmetric magnitude) — for AM/NBFM this keeps both
      // sidebands; for SSB it bounds the kept (positive) half.
      if (keep) {
        const af = Math.abs(f);
        if (af < passLo || af > passHi) keep = 0;
      }
      this.keepMask[k] = keep;
    }
  }

  feed(iqBytes: Uint8Array): void {
    const nPairs = iqBytes.length >> 2;
    if (nPairs === 0) return;
    const mode = this.mode;
    const lsb = (mode === 'lsb' || mode === 'sal');
    let w = this.bufFill;
    for (let i = 0; i < nPairs; i++) {
      const off = i * 4;
      const I = (((iqBytes[off]     << 8) | iqBytes[off + 1]) << 16 >> 16) / 32768;
      const Qraw = (((iqBytes[off + 2] << 8) | iqBytes[off + 3]) << 16 >> 16) / 32768;
      // LSB path: conjugate to put the lower sideband into the positive
      // baseband so the same downstream code handles both.
      const Q = lsb ? -Qraw : Qraw;
      this.bufRe[w] = I;
      this.bufIm[w] = Q;
      w++;
      if (w >= this.bufRe.length) {
        // Safety drain — caller pacing should never let this trigger.
        this.bufFill = w;
        this.process();
        w = this.bufFill;
      }
    }
    this.bufFill = w;
    while (this.bufFill >= N) this.process();
  }

  private process(): void {
    const win = this.window;
    // Windowed analysis.
    for (let i = 0; i < N; i++) {
      this.fftRe[i] = this.bufRe[i] * win[i];
      this.fftIm[i] = this.bufIm[i] * win[i];
    }
    fft(this.fftRe, this.fftIm);
    // Brick-wall channel filter.
    const mask = this.keepMask;
    for (let k = 0; k < N; k++) {
      if (!mask[k]) { this.fftRe[k] = 0; this.fftIm[k] = 0; }
    }
    ifft(this.fftRe, this.fftIm);
    // Synthesis windowing + overlap-add. First HOP samples = previous
    // tail + new windowed; second HOP samples become the new tail.
    const mode = this.mode;
    const gain = this.gain;
    const fmScale = 1 / Math.PI;
    const out = this.audioOut;
    const outLen = out.length;
    for (let i = 0; i < HOP; i++) {
      // OLA reconstruct.
      const re = this.fftRe[i] * win[i] + this.olaTailRe[i];
      const im = this.fftIm[i] * win[i] + this.olaTailIm[i];
      // Per-mode time-domain demod on the reconstructed sample.
      let s: number;
      switch (mode) {
        case 'am':
        case 'sam': {
          const env = Math.sqrt(re * re + im * im);
          this.amDc = 0.9995 * this.amDc + 0.0005 * env;
          s = env - this.amDc;
          break;
        }
        case 'nbfm': {
          const num = re * this.fmPrevQ - im * this.fmPrevI;
          const den = re * re + im * im + 1e-9;
          s = (num / den) * fmScale;
          this.fmPrevI = re; this.fmPrevQ = im;
          break;
        }
        default:
          // USB / LSB / CW / sub-AM-stereo modes — take real part.
          s = re;
      }
      s *= gain;
      if (s > 1) s = 1; else if (s < -1) s = -1;
      this.decimPhase++;
      if (this.decimPhase >= this.decim) {
        this.decimPhase = 0;
        out[this.audioOutFill++] = s;
        if (this.audioOutFill >= outLen) this.emit();
      }
    }
    // Stash the second half as the next overlap tail.
    for (let i = 0; i < HOP; i++) {
      this.olaTailRe[i] = this.fftRe[HOP + i] * win[HOP + i];
      this.olaTailIm[i] = this.fftIm[HOP + i] * win[HOP + i];
    }
    // Shift the analysis buffer forward by HOP.
    const remain = this.bufFill - HOP;
    for (let i = 0; i < remain; i++) {
      this.bufRe[i] = this.bufRe[i + HOP];
      this.bufIm[i] = this.bufIm[i + HOP];
    }
    this.bufFill = remain;
  }

  private emit(): void {
    if (!this.onAudio) { this.audioOutFill = 0; return; }
    const n = this.audioOutFill;
    if (n === 0) return;
    const buf = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, this.audioOut[i]));
      const i16 = Math.round(v * 32767);
      buf[i * 2]     = (i16 >> 8) & 0xff;
      buf[i * 2 + 1] = i16 & 0xff;
    }
    this.audioOutFill = 0;
    this.onAudio(buf);
  }

  reset(): void {
    this.bufFill = 0;
    this.olaTailRe.fill(0);
    this.olaTailIm.fill(0);
    this.audioOut.fill(0);
    this.audioOutFill = 0;
    this.decimPhase = 0;
    this.amDc = 0;
    this.fmPrevI = 0; this.fmPrevQ = 0;
  }
}
