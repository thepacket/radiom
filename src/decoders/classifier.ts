/** Heuristic ham digital-mode classifier.
 *
 *  Runs windowed FFTs over the 12 kHz int16 audio stream and looks at:
 *    • occupied bandwidth (where the spectrum exceeds the noise floor)
 *    • number / spacing of distinct spectral peaks
 *    • on/off variance of the strongest peak (CW keys hard; PSK is steady)
 *
 *  Decision rules (rough, in priority order):
 *    silent       — average band energy ≈ noise floor
 *    CW           — 1–2 narrow peaks, < 400 Hz BW, on/off ratio > 5
 *    PSK31        — 1 narrow peak, < 120 Hz BW, on/off ratio < 3 (constant carrier)
 *    RTTY         — 2 dominant peaks, 130–900 Hz apart (170/200/425/850 shifts)
 *    FT8/FT4      — 3+ closely-spaced tones, < 200 Hz BW
 *    Olivia/Contestia  — 4+ tones, 200–2200 Hz BW
 *    SSB voice    — > 1500 Hz BW, no dominant tone structure
 *    unknown      — anything else
 *
 *  Confidence is a hand-tuned 0–1 score that reflects how cleanly the rule
 *  fired, not a calibrated probability.
 */

export interface ClassifierResult {
  mode: string;
  confidence: number;
  details: string;
}

export interface ModeClassifierOpts {
  sampleRate: number;
  onResult: (r: ClassifierResult) => void;
}

export class ModeClassifier {
  private sr: number;
  private fftSize = 4096; // ~340 ms @ 12 kHz, ~2.9 Hz resolution
  private buf: Float32Array;
  private bufPos = 0;
  private hann: Float32Array;
  private re: Float32Array;
  private im: Float32Array;
  private history: Float32Array[] = []; // last ~5 s of magnitude spectra
  private framesSinceClassify = 0;
  private onResult: (r: ClassifierResult) => void;

  constructor(opts: ModeClassifierOpts) {
    this.sr = opts.sampleRate;
    this.onResult = opts.onResult;
    this.buf = new Float32Array(this.fftSize);
    this.hann = makeHann(this.fftSize);
    this.re = new Float32Array(this.fftSize);
    this.im = new Float32Array(this.fftSize);
  }

  feed(samples: Int16Array) {
    const n = samples.length;
    let i = 0;
    while (i < n) {
      const room = this.fftSize - this.bufPos;
      const take = Math.min(room, n - i);
      for (let k = 0; k < take; k++) this.buf[this.bufPos + k] = samples[i + k] / 32768;
      this.bufPos += take;
      i += take;
      if (this.bufPos >= this.fftSize) {
        this.processFrame();
        // 50 % overlap
        this.buf.copyWithin(0, this.fftSize / 2);
        this.bufPos = this.fftSize / 2;
      }
    }
  }

  private processFrame() {
    const N = this.fftSize;
    for (let i = 0; i < N; i++) {
      this.re[i] = this.buf[i] * this.hann[i];
      this.im[i] = 0;
    }
    fftRadix2(this.re, this.im);
    const N2 = N / 2;
    const mag = new Float32Array(N2);
    for (let i = 0; i < N2; i++) {
      mag[i] = Math.sqrt(this.re[i] * this.re[i] + this.im[i] * this.im[i]);
    }
    this.history.push(mag);
    if (this.history.length > 30) this.history.shift();

    this.framesSinceClassify++;
    if (this.framesSinceClassify >= 6 && this.history.length >= 8) {
      this.framesSinceClassify = 0;
      this.classify();
    }
  }

  private classify() {
    const N2 = this.fftSize / 2;
    const binHz = this.sr / this.fftSize;
    const H = this.history.length;
    const mean = new Float32Array(N2);
    for (const m of this.history) for (let i = 0; i < N2; i++) mean[i] += m[i];
    for (let i = 0; i < N2; i++) mean[i] /= H;

    // Audio passband 200–3000 Hz
    const lo = Math.floor(200 / binHz);
    const hi = Math.min(N2 - 1, Math.floor(3000 / binHz));

    // Noise floor: 25th-percentile of in-band mean magnitudes.
    const slice = Array.from(mean.subarray(lo, hi)).sort((a, b) => a - b);
    const noiseFloor = slice[Math.floor(slice.length * 0.25)] || 1e-9;
    const peakThr = noiseFloor * 4; // ~12 dB above floor

    // Average band energy.
    let bandSum = 0;
    for (let i = lo; i < hi; i++) bandSum += mean[i];
    const bandAvg = bandSum / (hi - lo);
    if (bandAvg < noiseFloor * 1.5) {
      this.onResult({ mode: 'silent', confidence: 0.9, details: `floor=${noiseFloor.toExponential(2)}` });
      return;
    }

    // Find peaks (5-bin local maxima above the threshold).
    const peaks: Array<{ bin: number; hz: number; mag: number }> = [];
    for (let i = lo + 2; i < hi - 2; i++) {
      const v = mean[i];
      if (v > peakThr &&
          v >= mean[i - 1] && v >= mean[i + 1] &&
          v >= mean[i - 2] && v >= mean[i + 2]) {
        peaks.push({ bin: i, hz: i * binHz, mag: v });
      }
    }
    peaks.sort((a, b) => b.mag - a.mag);

    // Occupied bandwidth.
    let firstHot = -1, lastHot = -1;
    for (let i = lo; i < hi; i++) {
      if (mean[i] > peakThr) { if (firstHot < 0) firstHot = i; lastHot = i; }
    }
    const occupiedBw = firstHot < 0 ? 0 : (lastHot - firstHot) * binHz;

    if (peaks.length === 0) {
      this.onResult({ mode: 'unknown', confidence: 0.1, details: `bw=${occupiedBw.toFixed(0)} Hz, no peaks` });
      return;
    }

    // On/off ratio of the strongest peak across the history window.
    const top = peaks[0];
    let mn = Infinity, mx = 0;
    for (const m of this.history) {
      const v = m[top.bin];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const onOff = mx / Math.max(mn, noiseFloor);

    const cluster = peaks.filter((p) => Math.abs(p.hz - top.hz) < 100).length;

    // PSK31: very narrow steady carrier.
    if (cluster <= 2 && occupiedBw < 120 && onOff < 3) {
      this.onResult({
        mode: 'PSK31',
        confidence: 0.7,
        details: `pitch ${top.hz.toFixed(0)} Hz, BW ${occupiedBw.toFixed(0)} Hz`,
      });
      return;
    }

    // CW: narrow, on/off keyed.
    if (cluster <= 2 && occupiedBw < 400 && onOff > 5) {
      this.onResult({
        mode: 'CW',
        confidence: 0.75,
        details: `pitch ${top.hz.toFixed(0)} Hz, on/off ${onOff.toFixed(1)}`,
      });
      return;
    }

    // RTTY: two dominant peaks, 130–900 Hz apart, similar amplitude.
    if (peaks.length >= 2) {
      const p2 = peaks[1];
      const shift = Math.abs(top.hz - p2.hz);
      if (top.mag / p2.mag < 4 && shift > 130 && shift < 900) {
        const std = shift < 190 ? '170' : shift < 220 ? '200' : shift < 460 ? '425' : '850';
        const mark = Math.min(top.hz, p2.hz);
        const space = Math.max(top.hz, p2.hz);
        this.onResult({
          mode: 'RTTY',
          confidence: 0.7,
          details: `${mark.toFixed(0)} / ${space.toFixed(0)} Hz (~${std} Hz shift)`,
        });
        return;
      }
    }

    // FT8 / FT4: 3+ tones inside ~200 Hz.
    if (peaks.length >= 3 && occupiedBw <= 200) {
      this.onResult({
        mode: 'FT8/FT4',
        confidence: 0.55,
        details: `${peaks.length} tones, ${occupiedBw.toFixed(0)} Hz BW`,
      });
      return;
    }

    // Olivia / MFSK: many tones, mid-bandwidth.
    if (peaks.length >= 4 && occupiedBw > 200 && occupiedBw < 2200) {
      this.onResult({
        mode: 'Olivia/Contestia',
        confidence: 0.55,
        details: `${peaks.length} tones, ${occupiedBw.toFixed(0)} Hz BW`,
      });
      return;
    }

    // SSB voice: broadband, no clear tonal structure.
    if (occupiedBw > 1500) {
      this.onResult({
        mode: 'SSB voice',
        confidence: 0.5,
        details: `${occupiedBw.toFixed(0)} Hz BW, ${peaks.length} peaks`,
      });
      return;
    }

    this.onResult({
      mode: 'unknown',
      confidence: 0.2,
      details: `${peaks.length} peaks, ${occupiedBw.toFixed(0)} Hz BW`,
    });
  }
}

function makeHann(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  return w;
}

/** In-place radix-2 Cooley-Tukey FFT. N must be a power of two. */
function fftRadix2(re: Float32Array, im: Float32Array): void {
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
