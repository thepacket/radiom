/** Independent Sideband (iSB) demodulator — pure client-side DSP from
 *  KiwiSDR complex baseband.
 *
 *  KiwiSDR's 'iq' mode delivers analytic baseband centered on the tuned
 *  frequency. ISB carries two independent audio channels: the upper
 *  sideband and the lower sideband. We separate them by zeroing one
 *  half of the spectrum, IFFT back to time domain, and route LSB to the
 *  left speaker / USB to the right.
 *
 *  Processing: 1024-point complex FFT with 50 % Hann-windowed
 *  overlap-add (≈85 ms total block, ≈42 ms hop at 12 kHz IQ rate).
 *  Output is scheduled as back-to-back AudioBufferSourceNodes at the
 *  IQ sample rate; Web Audio handles the upsample to ctx rate.
 */

export interface IsbDemodOpts {
  ctx: AudioContext;
  inputRate: number;
  /** Gain applied after sideband separation (linear). Default 4.0 — the
   *  zero-half-spectrum filter loses ~3 dB and the windowed overlap-add
   *  reconstruction is unity, so a small boost makes ISB audible at
   *  speaker volumes comparable to the Kiwi LSB/USB modes. */
  gain?: number;
  /** If true, swap which sideband goes to which speaker. Default false:
   *  LSB → left, USB → right. */
  swap?: boolean;
}

const N = 1024;
const HOP = N >> 1;

function makeHann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/** In-place radix-2 Cooley-Tukey complex FFT. N must be a power of two. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
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

/** Inverse FFT via conjugate trick. Scales by 1/N. */
function ifft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= inv;
    im[i] = -im[i] * inv;
  }
}

export class IsbDemod {
  private ctx: AudioContext;
  private inputRate: number;
  private gain: number;
  private swap: boolean;

  /** Sliding analysis buffer (complex). Grows as IQ arrives; once it
   *  holds ≥ N samples we process and shift forward by HOP. */
  private bufRe: Float32Array = new Float32Array(N * 2);
  private bufIm: Float32Array = new Float32Array(N * 2);
  private bufFill = 0;

  /** Synthesis accumulator (overlap-add). Each processed block adds N
   *  samples of windowed real audio to outL/outR; the first HOP are
   *  emitted to the speaker, then the buffer shifts left by HOP. */
  private outL: Float32Array = new Float32Array(N);
  private outR: Float32Array = new Float32Array(N);

  /** Scratch buffers reused across blocks. */
  private workRe: Float32Array = new Float32Array(N);
  private workIm: Float32Array = new Float32Array(N);
  private usbRe: Float32Array = new Float32Array(N);
  private usbIm: Float32Array = new Float32Array(N);
  private lsbRe: Float32Array = new Float32Array(N);
  private lsbIm: Float32Array = new Float32Array(N);
  private window: Float32Array = makeHann(N);

  /** Next start time for the scheduled audio chunk. Maintained ahead of
   *  ctx.currentTime so chunks play back-to-back without gaps. */
  private nextStart = 0;
  /** Active source nodes — closed on stop(). */
  private liveNodes: Set<AudioBufferSourceNode> = new Set();
  private out: GainNode;
  private closed = false;

  constructor(opts: IsbDemodOpts) {
    this.ctx = opts.ctx;
    this.inputRate = opts.inputRate;
    this.gain = opts.gain ?? 4.0;
    this.swap = opts.swap ?? false;
    this.out = this.ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(this.ctx.destination);
  }

  setGain(g: number): void { this.gain = g; }
  setSwap(s: boolean): void { this.swap = s; }

  /** Feed raw KiwiSDR IQ payload bytes (interleaved I16 BE I/Q, GPS
   *  header already stripped by the player). */
  feed(iqBytes: Uint8Array): void {
    if (this.closed) return;
    // Decode I/Q int16 BE into Float32 [-1, 1].
    const samples = iqBytes.length >> 2; // 4 bytes per I/Q pair
    if (samples === 0) return;
    // Grow buffer if needed.
    const need = this.bufFill + samples;
    if (need > this.bufRe.length) {
      const cap = Math.max(need, this.bufRe.length * 2);
      const nr = new Float32Array(cap);
      const ni = new Float32Array(cap);
      nr.set(this.bufRe.subarray(0, this.bufFill));
      ni.set(this.bufIm.subarray(0, this.bufFill));
      this.bufRe = nr;
      this.bufIm = ni;
    }
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    let off = 0;
    for (let i = 0; i < samples; i++) {
      const I = dv.getInt16(off, false); off += 2;
      const Q = dv.getInt16(off, false); off += 2;
      this.bufRe[this.bufFill + i] = I / 32768;
      this.bufIm[this.bufFill + i] = Q / 32768;
    }
    this.bufFill += samples;

    // Process every full N-sample window, advancing by HOP.
    while (this.bufFill >= N) {
      this.processBlock();
      // Shift buffer left by HOP.
      const remain = this.bufFill - HOP;
      this.bufRe.copyWithin(0, HOP, HOP + remain);
      this.bufIm.copyWithin(0, HOP, HOP + remain);
      this.bufFill = remain;
    }
  }

  private processBlock(): void {
    const w = this.window;
    // Windowed copy into work buffers.
    for (let i = 0; i < N; i++) {
      this.workRe[i] = this.bufRe[i] * w[i];
      this.workIm[i] = this.bufIm[i] * w[i];
    }
    fft(this.workRe, this.workIm);

    // Split spectrum. Bin 0 = DC, bins 1..N/2-1 = positive freqs (USB
    // content), bin N/2 = Nyquist, bins N/2+1..N-1 = negative freqs
    // (LSB content). Zero DC and Nyquist in both — DC bleed is the
    // residual carrier from a slightly mis-tuned SAM signal and adds
    // nothing intelligible.
    const half = N >> 1;
    const ur = this.usbRe, ui = this.usbIm;
    const lr = this.lsbRe, li = this.lsbIm;
    ur[0] = 0; ui[0] = 0;
    lr[0] = 0; li[0] = 0;
    ur[half] = 0; ui[half] = 0;
    lr[half] = 0; li[half] = 0;
    for (let k = 1; k < half; k++) {
      ur[k] = this.workRe[k];
      ui[k] = this.workIm[k];
      lr[k] = 0; li[k] = 0;
    }
    for (let k = half + 1; k < N; k++) {
      ur[k] = 0; ui[k] = 0;
      lr[k] = this.workRe[k];
      li[k] = this.workIm[k];
    }
    ifft(ur, ui);
    ifft(lr, li);

    // Synthesis-window each result and overlap-add into outL/outR.
    // Hann analysis × Hann synthesis with 50% hop yields ~1.5× sum-of-
    // squares; the constant 2/3 below normalises that back to ~unity.
    const k = (2 / 3) * this.gain;
    for (let i = 0; i < N; i++) {
      const ws = w[i] * k;
      this.outR[i] += ur[i] * ws;
      this.outL[i] += lr[i] * ws;
    }

    // Emit the first HOP samples (now fully formed by two consecutive
    // analysis windows) and shift the accumulator.
    this.emit(this.outL.subarray(0, HOP), this.outR.subarray(0, HOP));
    this.outL.copyWithin(0, HOP, N);
    this.outR.copyWithin(0, HOP, N);
    this.outL.fill(0, HOP, N);
    this.outR.fill(0, HOP, N);
  }

  private emit(l: Float32Array, r: Float32Array): void {
    if (this.closed) return;
    const ctx = this.ctx;
    const buf = ctx.createBuffer(2, l.length, this.inputRate);
    if (this.swap) {
      buf.getChannelData(0).set(r);
      buf.getChannelData(1).set(l);
    } else {
      buf.getChannelData(0).set(l);
      buf.getChannelData(1).set(r);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const now = ctx.currentTime;
    if (this.nextStart < now + 0.02) this.nextStart = now + 0.05;
    src.start(this.nextStart);
    this.nextStart += l.length / this.inputRate;
    this.liveNodes.add(src);
    src.onended = () => { this.liveNodes.delete(src); };
  }

  /** Tear down. Stops any pending playback and disconnects nodes. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const n of this.liveNodes) {
      try { n.stop(); } catch {}
      try { n.disconnect(); } catch {}
    }
    this.liveNodes.clear();
    try { this.out.disconnect(); } catch {}
  }
}
