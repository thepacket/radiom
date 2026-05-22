/** LSB2 / USB2 — client-side SSB demodulator driven by the IQ-domain
 *  cleanup filter chain (NB → DCK → Passband + Notch + Sideband-select
 *  → Wiener NR). Built so the operator can A/B-compare it against the
 *  server-side Kiwi LSB/USB audio paths.
 *
 *  Pipeline (per 1024-sample overlap-add block, 50 % Hann analysis):
 *    1.  Decode int16 BE IQ → Float32 I/Q
 *    2.  NB     (per-block magnitude median + k·MAD outlier zap)
 *    3.  DCK    (Hampel on |z|, phase-preserved replacement)
 *    4.  FFT to complex baseband spectrum
 *    5.  Mask  — passband window (±bw/2 around DC) AND sideband
 *               selector (USB keeps positive bins, LSB keeps negative)
 *               AND notches (a few zeroed bins)
 *    6.  Wiener NR with per-bin running noise estimate
 *    7.  IFFT, synthesis-window, overlap-add
 *    8.  Real part = SSB audio, emitted as scheduled AudioBufferSources
 *
 *  This decoder *never* touches the audio path's filters. It produces
 *  its own audio stream that plays alongside / instead of the Kiwi-
 *  demodulated audio (operator toggles modes to A/B).
 */

export type SsbSide = 'L' | 'U';

export interface SsbFilteredOpts {
  ctx: AudioContext;
  inputRate: number;
  side: SsbSide;
  bandwidthHz: number;
  notchHzList?: number[];
  notchWidthHz?: number;
  gain?: number;
  /** Filter-chain toggles (default all on). */
  nb?: boolean;
  dck?: boolean;
  passband?: boolean;
  nr?: boolean;
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

function ifft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
}

export class SsbFilteredDemod {
  private ctx: AudioContext;
  private inputRate: number;
  private side: SsbSide;
  private bandwidthHz: number;
  private notchBins: Set<number> = new Set();
  private gain: number;
  private flags: { nb: boolean; dck: boolean; passband: boolean; nr: boolean };

  private bufRe = new Float32Array(N * 2);
  private bufIm = new Float32Array(N * 2);
  private bufFill = 0;

  private out = new Float32Array(N);
  private workRe = new Float32Array(N);
  private workIm = new Float32Array(N);
  private mask = new Float32Array(N);
  private window = makeHann(N);

  /** Per-bin running noise PSD estimate, exponentially averaged with a
   *  bias toward small values (Lin-Yu minimum-tracking lite). */
  private noisePsd = new Float32Array(N);
  private noiseInit = false;

  private nextStart = 0;
  private liveNodes: Set<AudioBufferSourceNode> = new Set();
  private outGain: GainNode;
  private closed = false;

  constructor(opts: SsbFilteredOpts) {
    this.ctx = opts.ctx;
    this.inputRate = opts.inputRate;
    this.side = opts.side;
    this.bandwidthHz = opts.bandwidthHz;
    this.gain = opts.gain ?? 4.0;
    this.flags = {
      nb: opts.nb ?? true,
      dck: opts.dck ?? true,
      passband: opts.passband ?? true,
      nr: opts.nr ?? true,
    };
    this.rebuildMask(opts.notchHzList ?? [], opts.notchWidthHz ?? 10);
    this.outGain = this.ctx.createGain();
    this.outGain.gain.value = 1;
    this.outGain.connect(this.ctx.destination);
  }

  setBandwidth(hz: number, notchHzList: number[] = [], notchWidthHz = 10): void {
    this.bandwidthHz = hz;
    this.rebuildMask(notchHzList, notchWidthHz);
  }

  setSide(side: SsbSide): void {
    this.side = side;
    // Rebuild without changing notches — caller can re-issue setBandwidth
    // if they want to refresh notches at the same time.
    this.rebuildMaskCore();
  }

  setGain(g: number): void { this.gain = g; }

  /** Compute the multiplicative spectral mask from the current bandwidth,
   *  side, and notch set. */
  private rebuildMask(notchHzList: number[], notchWidthHz: number): void {
    const binHz = this.inputRate / N;
    this.notchBins.clear();
    const wBins = Math.max(1, Math.round(notchWidthHz / binHz / 2));
    for (const hz of notchHzList) {
      const k0 = ((Math.round(hz / binHz) % N) + N) % N;
      for (let d = -wBins; d <= wBins; d++) {
        const k = (((k0 + d) % N) + N) % N;
        this.notchBins.add(k);
      }
    }
    this.rebuildMaskCore();
  }

  private rebuildMaskCore(): void {
    const half = N >> 1;
    const binHz = this.inputRate / N;
    const halfBwBins = (this.bandwidthHz / 2) / binHz;
    const taperBins = Math.max(1, halfBwBins * 0.1);
    for (let k = 0; k < N; k++) {
      let g = 1;
      const sBin = k < half ? k : k - N; // signed bin offset
      const f = Math.abs(sBin);
      if (this.flags.passband) {
        if (f > halfBwBins) g = 0;
        else if (f > halfBwBins - taperBins) {
          const t = (f - (halfBwBins - taperBins)) / taperBins;
          g *= 0.5 * (1 + Math.cos(Math.PI * t));
        }
      }
      // Sideband selector: USB keeps k=1..half-1; LSB keeps k=half+1..N-1.
      // DC and Nyquist are always zeroed.
      if (k === 0 || k === half) g = 0;
      else if (this.side === 'U' && k >= half) g = 0;
      else if (this.side === 'L' && k < half) g = 0;
      if (this.notchBins.has(k)) g = 0;
      this.mask[k] = g;
    }
  }

  /** Feed raw KiwiSDR IQ payload bytes (interleaved I16 BE I/Q). */
  feed(iqBytes: Uint8Array): void {
    if (this.closed) return;
    const samples = iqBytes.length >> 2;
    if (samples === 0) return;
    const need = this.bufFill + samples;
    if (need > this.bufRe.length) {
      const cap = Math.max(need, this.bufRe.length * 2);
      const nr = new Float32Array(cap);
      const ni = new Float32Array(cap);
      nr.set(this.bufRe.subarray(0, this.bufFill));
      ni.set(this.bufIm.subarray(0, this.bufFill));
      this.bufRe = nr; this.bufIm = ni;
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
    while (this.bufFill >= N) {
      this.processBlock();
      const remain = this.bufFill - HOP;
      this.bufRe.copyWithin(0, HOP, HOP + remain);
      this.bufIm.copyWithin(0, HOP, HOP + remain);
      this.bufFill = remain;
    }
  }

  private processBlock(): void {
    // Copy block into work buffers; we'll mutate in place for NB / DCK.
    for (let i = 0; i < N; i++) {
      this.workRe[i] = this.bufRe[i];
      this.workIm[i] = this.bufIm[i];
    }

    // ── NB: magnitude median + k·MAD blanker (k=5).
    if (this.flags.nb) {
      const mags: number[] = new Array(N);
      for (let i = 0; i < N; i++) mags[i] = Math.hypot(this.workRe[i], this.workIm[i]);
      const sorted = mags.slice().sort((a, b) => a - b);
      const med = sorted[N >> 1] || 0;
      const dev = mags.map(v => Math.abs(v - med)).sort((a, b) => a - b);
      const mad = dev[N >> 1] || 0;
      const thr = med + 5 * 1.4826 * mad;
      for (let i = 0; i < N; i++) {
        if (mags[i] > thr) { this.workRe[i] = 0; this.workIm[i] = 0; }
      }
    }

    // ── DCK: Hampel on |z|, half-window 8, σ-thr 4. O(N·W·log W).
    if (this.flags.dck) {
      const halfW = 8;
      const wL = 2 * halfW + 1;
      const ringMag = new Float32Array(N);
      for (let i = 0; i < N; i++) ringMag[i] = Math.hypot(this.workRe[i], this.workIm[i]);
      const buf = new Float64Array(wL);
      for (let i = halfW; i < N - halfW; i++) {
        for (let j = -halfW; j <= halfW; j++) buf[j + halfW] = ringMag[i + j];
        const s = Array.from(buf).sort((a, b) => a - b);
        const m = s[halfW];
        const d: number[] = [];
        for (let j = 0; j < wL; j++) d.push(Math.abs(buf[j] - m));
        d.sort((a, b) => a - b);
        const sigma = 1.4826 * d[halfW];
        if (sigma > 0 && Math.abs(ringMag[i] - m) > 4 * sigma) {
          const mag = ringMag[i];
          if (mag > 0) {
            const s2 = m / mag;
            this.workRe[i] *= s2; this.workIm[i] *= s2;
          }
        }
      }
    }

    // ── Analysis window then FFT.
    for (let i = 0; i < N; i++) {
      this.workRe[i] *= this.window[i];
      this.workIm[i] *= this.window[i];
    }
    fft(this.workRe, this.workIm);

    // ── Apply mask (passband + notches + sideband selector).
    for (let k = 0; k < N; k++) {
      this.workRe[k] *= this.mask[k];
      this.workIm[k] *= this.mask[k];
    }

    // ── Wiener NR with running noise estimate.
    if (this.flags.nr) {
      const overSub = 1.4;
      const floor = 0.1;
      if (!this.noiseInit) {
        for (let k = 0; k < N; k++) {
          this.noisePsd[k] = this.workRe[k] * this.workRe[k] + this.workIm[k] * this.workIm[k];
        }
        this.noiseInit = true;
      } else {
        // Min-tracking lite: if this frame is quieter than the estimate,
        // jump down quickly; else drift up slowly.
        for (let k = 0; k < N; k++) {
          const pk = this.workRe[k] * this.workRe[k] + this.workIm[k] * this.workIm[k];
          if (pk < this.noisePsd[k]) this.noisePsd[k] = 0.9 * this.noisePsd[k] + 0.1 * pk;
          else this.noisePsd[k] = 0.995 * this.noisePsd[k] + 0.005 * pk;
        }
      }
      for (let k = 0; k < N; k++) {
        const pk = this.workRe[k] * this.workRe[k] + this.workIm[k] * this.workIm[k];
        const g = Math.max(floor, 1 - overSub * this.noisePsd[k] / Math.max(pk, 1e-20));
        this.workRe[k] *= g;
        this.workIm[k] *= g;
      }
    }

    ifft(this.workRe, this.workIm);

    // SSB audio = real part of inverse-transformed sideband-selected
    // analytic signal. (Im part is the Hilbert pair — discarded.)
    const k = (2 / 3) * this.gain;
    for (let i = 0; i < N; i++) {
      this.out[i] += this.workRe[i] * this.window[i] * k;
    }

    this.emit(this.out.subarray(0, HOP));
    this.out.copyWithin(0, HOP, N);
    this.out.fill(0, HOP, N);
  }

  private emit(audio: Float32Array): void {
    if (this.closed) return;
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, audio.length, this.inputRate);
    buf.getChannelData(0).set(audio);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outGain);
    const now = ctx.currentTime;
    if (this.nextStart < now + 0.02) this.nextStart = now + 0.05;
    src.start(this.nextStart);
    this.nextStart += audio.length / this.inputRate;
    this.liveNodes.add(src);
    src.onended = () => { this.liveNodes.delete(src); };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const n of this.liveNodes) {
      try { n.stop(); } catch {}
      try { n.disconnect(); } catch {}
    }
    this.liveNodes.clear();
    try { this.outGain.disconnect(); } catch {}
  }
}
