/** Time-windowed running average of waterfall FFT bins, rendered as a
 *  horizontal colored strip using the same palette + stretch the main
 *  spectrum view uses.
 *
 *  Each pushFrame() drops the new frame into a time-stamped ring buffer.
 *  Frames older than `avgMs` are evicted before rendering, so the average
 *  always covers exactly the configured window regardless of input frame
 *  rate (which can vary with Kiwi wf_speed). */

import { PALETTES, buildLUT, type PaletteName } from './spectrum';

export class FftAverager {
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private lut: Uint32Array;
  private stretchLo = 130;
  private stretchHi = 220;
  /** Bins copies, one per recent frame. */
  private frames: Uint8Array[] = [];
  private times:  number[]     = [];
  private avgMs                = 5000;
  /** Latest computed average — kept so palette/stretch changes can repaint
   *  without waiting for a new frame. */
  private latestAvg: Float32Array | null = null;
  private rafScheduled = false;

  constructor(canvas: HTMLCanvasElement, palette: PaletteName = 'viridis') {
    this.cv  = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.lut = buildLUT(PALETTES[palette]);
  }

  setPalette(name: PaletteName): void {
    this.lut = buildLUT(PALETTES[name]);
    this.scheduleRender();
  }
  setStretch(lo: number, hi: number): void {
    this.stretchLo = lo; this.stretchHi = hi;
    this.scheduleRender();
  }
  setAvgSeconds(s: number): void {
    this.avgMs = Math.max(100, Math.round(s * 1000));
    this.prune();
    this.recomputeAverage();
    this.scheduleRender();
  }

  pushFrame(bins: Uint8Array): void {
    this.frames.push(new Uint8Array(bins));
    this.times.push(performance.now());
    this.prune();
    this.recomputeAverage();
    this.scheduleRender();
  }

  /** Reset history (e.g. on tune change, mode change). */
  clear(): void {
    this.frames.length = 0;
    this.times.length  = 0;
    this.latestAvg     = null;
    this.scheduleRender();
  }

  private prune(): void {
    const cutoff = performance.now() - this.avgMs;
    while (this.times.length > 0 && this.times[0] < cutoff) {
      this.times.shift();
      this.frames.shift();
    }
  }

  private recomputeAverage(): void {
    if (this.frames.length === 0) { this.latestAvg = null; return; }
    const N = this.frames[0].length;
    if (!this.latestAvg || this.latestAvg.length !== N) {
      this.latestAvg = new Float32Array(N);
    }
    const out = this.latestAvg;
    out.fill(0);
    for (const f of this.frames) {
      const M = Math.min(N, f.length);
      for (let i = 0; i < M; i++) out[i] += f[i];
    }
    const inv = 1 / this.frames.length;
    for (let i = 0; i < N; i++) out[i] *= inv;
  }

  private scheduleRender(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => { this.rafScheduled = false; this.render(); });
  }

  private render(): void {
    const cssW = this.cv.clientWidth, cssH = this.cv.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    if (this.cv.width !== W || this.cv.height !== H) {
      this.cv.width = W; this.cv.height = H;
    }

    const avg = this.latestAvg;
    if (!avg || avg.length === 0) {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, W, H);
      return;
    }

    const N      = avg.length;
    const lut    = this.lut;
    const lo     = this.stretchLo;
    const range  = (this.stretchHi - this.stretchLo) || 1;
    const img    = this.ctx.createImageData(W, 1);
    const buf32  = new Uint32Array(img.data.buffer);
    for (let x = 0; x < W; x++) {
      const bi = ((x * N) / W) | 0;
      const v  = avg[bi];
      let t = (v - lo) / range;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      buf32[x] = lut[(t * 255) | 0];
    }
    // Replicate the 1-row image down the canvas height — cheap and avoids
    // building a full W×H buffer when most of the time we only need a strip.
    this.ctx.putImageData(img, 0, 0);
    if (H > 1) this.ctx.drawImage(this.cv, 0, 0, W, 1, 0, 1, W, H - 1);
  }
}
