import type { WaterfallFrame } from '../kiwi/types';

export interface SpectrumOpts {
  mindb?: number;  // colormap floor
  maxdb?: number;  // colormap ceiling
}

/** Renders a live FFT line plot (top) and scrolling waterfall (bottom).
 *  Both canvases are CSS-sized; we manage their internal resolution at
 *  devicePixelRatio for crisp pixels on hi-DPI screens. */
export class SpectrumView {
  private fftCtx: CanvasRenderingContext2D;
  private wfCtx: CanvasRenderingContext2D;
  private lut: Uint32Array; // 256-entry RGBA LUT, packed
  private rowImageData: ImageData | null = null;
  private rowBuf: Uint32Array | null = null;
  private dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  constructor(
    private fft: HTMLCanvasElement,
    private wf: HTMLCanvasElement,
    opts: SpectrumOpts = {},
  ) {
    this.fftCtx = fft.getContext('2d')!;
    this.wfCtx = wf.getContext('2d', { willReadFrequently: false })!;
    void opts.mindb; void opts.maxdb;
    this.lut = buildLUT(PALETTES.viridis);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(fft);
    new ResizeObserver(() => this.resize()).observe(wf);
  }


  /** Stretch byte → display intensity. The user's Kiwi clusters most bytes
   *  between ~140 and ~210; without this stretch the whole waterfall is
   *  washed-out yellow. Tunable via setStretch(). */
  private stretchLo = 130;
  private stretchHi = 220;
  /** Row-duplication factor: each incoming WF frame is painted as N
   *  identical rows. Lets the operator fill the waterfall faster when
   *  the server's FPS is low. 1 = unchanged. */
  private wfDup = 1;
  setWfDup(n: number) { this.wfDup = Math.max(1, Math.min(8, n | 0)); }
  /** When true (default), duplicated rows fade between previous and
   *  current bins for a smooth gradient. When false, every duplicated
   *  row is the current bins as-is, giving a blockier "pixel" look. */
  private wfInterpolate = true;
  setWfInterpolation(on: boolean) { this.wfInterpolate = !!on; }
  /** Cached previous-frame bins for vertical interpolation when wfDup>1.
   *  Each painted row is then a weighted blend of "current" and
   *  "previous" bins, producing a smooth gradient instead of N copies
   *  of the same row (which is what creates the blocky pixel look). */
  private prevWfBins: Uint8Array | null = null;
  private intensity(byte: number): number {
    const t = (byte - this.stretchLo) / (this.stretchHi - this.stretchLo);
    return t <= 0 ? 0 : t >= 1 ? 1 : t;
  }
  setStretch(lo: number, hi: number) { this.stretchLo = lo; this.stretchHi = hi; }

  /** Exponential-moving-average smoothing on FFT bins (waterfall is unchanged).
   *  0 = no averaging (instant). 100 = heavy smoothing. */
  private fftAvgAlpha = 0;
  private fftSmoothed: Float32Array | null = null;
  private fftAvgOut: Uint8Array | null = null;
  setFftAveraging(value0to100: number): void {
    const v = Math.max(0, Math.min(100, value0to100));
    // Map 0..100 → alpha 0..0.95 (cap so updates still propagate).
    this.fftAvgAlpha = (v / 100) * 0.95;
  }
  private avgBins(bins: Uint8Array): Uint8Array {
    if (this.fftAvgAlpha <= 0) return bins;
    if (!this.fftSmoothed || this.fftSmoothed.length !== bins.length) {
      this.fftSmoothed = new Float32Array(bins);
    }
    if (!this.fftAvgOut || this.fftAvgOut.length !== bins.length) {
      this.fftAvgOut = new Uint8Array(bins.length);
    }
    const a = this.fftAvgAlpha;
    const inv = 1 - a;
    const sm = this.fftSmoothed!;
    const out = this.fftAvgOut!;
    for (let i = 0; i < bins.length; i++) {
      sm[i] = sm[i] * a + bins[i] * inv;
      out[i] = sm[i] | 0;
    }
    return out;
  }

  /** Wipe the waterfall canvas — used when CENT recenters the view so the
   *  scrolling history doesn't show pre-recenter offsets for several seconds. */
  clearWaterfall() {
    const W = this.wf.width, H = this.wf.height;
    if (W < 1 || H < 1) return;
    this.wfCtx.fillStyle = '#000';
    this.wfCtx.fillRect(0, 0, W, H);
  }
  setPalette(name: PaletteName) { this.lut = buildLUT(PALETTES[name]); }

  private resize() {
    for (const c of [this.fft, this.wf]) {
      const w = Math.max(1, Math.floor(c.clientWidth * this.dpr));
      const h = Math.max(1, Math.floor(c.clientHeight * this.dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    this.rowImageData = null;
    this.rowBuf = null;
  }

  private lastBins: Uint8Array | null = null;
  /** Normalized 0..1 cursor position on the FFT (0 = left edge). null = hidden. */
  private cursorT: number | null = null;
  private logMode = false;
  /** Whether to repaint the FFT canvas. The hosting app can hide the FFT
   *  pane (the live FFT was removed from radiom's layout). With this off
   *  we skip the per-frame trace draw entirely — saves the canvas state
   *  changes + path stroke on every waterfall row. */
  private drawFftEnabled = true;
  setDrawFftEnabled(on: boolean) { this.drawFftEnabled = on; }
  setCursor(t: number | null) {
    this.cursorT = t;
    if (this.drawFftEnabled && this.lastBins) this.drawFft(this.lastBins);
  }
  setLogMode(on: boolean) {
    this.logMode = on;
    if (this.drawFftEnabled && this.lastBins) this.drawFft(this.lastBins);
  }
  isLogMode() { return this.logMode; }

  /** Read-only access to the most recent waterfall bins (1024-wide,
   *  byte-quantised dB). Used by the SIG signal classifier to find the
   *  width of the signal centred on the tuning cursor. */
  getLastBins(): Uint8Array | null { return this.lastBins; }

  pushFrame(f: WaterfallFrame) {
    this.lastBins = f.bins;
    this.drawWaterfallRow(f.bins);
    if (this.drawFftEnabled) this.drawFft(f.bins);
  }

  /** Re-measure canvas pixel dimensions and redraw FFT line from the last
   *  frame. Use after the canvases come back from display:none — the
   *  ResizeObserver doesn't always fire on visibility-restoration. */
  redraw(): void {
    this.resize();
    if (this.drawFftEnabled && this.lastBins) this.drawFft(this.lastBins);
  }

  /** Pick BASE/TOP from percentiles of the most recent frame so signals stand
   *  out against the noise floor. Returns the chosen [base, top] or null. */
  autoScale(): [number, number] | null {
    const bins = this.lastBins;
    if (!bins || bins.length === 0) return null;
    const sorted = Uint8Array.from(bins).sort();
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    // 10th percentile = noise floor, 98th = strongest typical signals.
    let base = p(0.10);
    let top  = p(0.98);
    if (top - base < 30) top = Math.min(255, base + 30); // ensure visible range
    this.stretchLo = base;
    this.stretchHi = top;
    return [base, top];
  }

  /** Gentle continuous auto-scale: nudges the stretch window toward the
   *  current frame's p25/p99 percentiles. Call ~1Hz from the shell.
   *  Tighter percentiles than autoScale() so weak signals stay visible
   *  while bright bursts don't blow out the contrast. */
  autoScaleStep(rate = 0.25): [number, number] | null {
    const bins = this.lastBins;
    if (!bins || bins.length === 0) return null;
    const sorted = Uint8Array.from(bins).sort();
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    const targetLo = p(0.25);
    let targetHi = p(0.99);
    if (targetHi - targetLo < 30) targetHi = Math.min(255, targetLo + 30);
    this.stretchLo = Math.round(this.stretchLo * (1 - rate) + targetLo * rate);
    this.stretchHi = Math.round(this.stretchHi * (1 - rate) + targetHi * rate);
    return [this.stretchLo, this.stretchHi];
  }

  private drawWaterfallRow(bins: Uint8Array) {
    const ctx = this.wfCtx;
    const W = this.wf.width, H = this.wf.height;
    if (W < 2 || H < 2) return;
    const dup = Math.min(this.wfDup, H - 1);

    // Scroll existing content down by `dup` rows.
    ctx.drawImage(this.wf, 0, 0, W, H - dup, 0, dup, W, H - dup);

    // Build a 1×W ImageData by mapping bins → pixel columns via nearest neighbor.
    if (!this.rowImageData || this.rowImageData.width !== W) {
      this.rowImageData = ctx.createImageData(W, 1);
      this.rowBuf = new Uint32Array(this.rowImageData.data.buffer);
    }
    const buf = this.rowBuf!;
    const N = bins.length;
    const prev = this.prevWfBins;
    if (dup === 1 || !prev || prev.length !== N || !this.wfInterpolate) {
      // No interpolation: paint each of `dup` rows from the current bins
      // as-is, giving the classic blocky duplicated look.
      for (let x = 0; x < W; x++) {
        const bin = bins[((x * N) / W) | 0];
        const t = this.intensity(bin);
        buf[x] = this.lut[(t * 255) | 0];
      }
      for (let r = 0; r < dup; r++) ctx.putImageData(this.rowImageData!, 0, r);
    } else {
      // dup > 1: paint `dup` rows where row 0 (top, newest) is the
      // current bins and row dup-1 fades toward the previous bins. The
      // blend is done in byte/intensity space (then through stretch +
      // LUT) so the colours follow the same palette curve.
      for (let r = 0; r < dup; r++) {
        // r=0 → w=0 (100% current); r=dup-1 → w≈1 (100% previous).
        const w = r / dup;
        for (let x = 0; x < W; x++) {
          const idx = ((x * N) / W) | 0;
          const cur = bins[idx];
          const old = prev[idx];
          const blended = (cur * (1 - w) + old * w) | 0;
          const t = this.intensity(blended);
          buf[x] = this.lut[(t * 255) | 0];
        }
        ctx.putImageData(this.rowImageData!, 0, r);
      }
    }
    // Cache for the next frame's interpolation.
    if (!this.prevWfBins || this.prevWfBins.length !== bins.length) {
      this.prevWfBins = new Uint8Array(bins.length);
    }
    this.prevWfBins.set(bins);
  }

  private drawFft(bins: Uint8Array) {
    const ctx = this.fftCtx;
    const W = this.fft.width, H = this.fft.height;
    if (W < 2 || H < 2) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e8e8e8';
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.beginPath();
    const N = bins.length;
    const FLOOR = this.stretchLo;
    // HiW (stretchHi) sets the FFT vertical ceiling so signals at HiW reach
    // the top of the canvas. Guard against degenerate spans.
    const SPAN = Math.max(1, this.stretchHi - this.stretchLo);
    const fftBins = this.avgBins(bins);
    for (let x = 0; x < W; x++) {
      const bin = fftBins[((x * N) / W) | 0];
      let t = (bin - FLOOR) / SPAN;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      // log10(1 + 9·t): expands the weak end, compresses the strong end.
      const ty = this.logMode ? Math.log10(1 + 9 * t) : t;
      const y = H - 1 - ty * (H - 1);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Tuning cursor — vertical red line.
    if (this.cursorT != null && this.cursorT >= 0 && this.cursorT <= 1) {
      const cx = Math.round(this.cursorT * (W - 1));
      ctx.strokeStyle = '#f04e3a';
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, 0);
      ctx.lineTo(cx + 0.5, H);
      ctx.stroke();
    }

    // "log" indicator (top-right) when log mode is active.
    if (this.logMode) {
      const fs = Math.round(11 * this.dpr);
      ctx.font = `${fs}px ui-monospace, monospace`;
      ctx.fillStyle = '#9a9a9a';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('log', W - 6 * this.dpr, 4 * this.dpr);
    }
  }
}

/** Color stop: [t in 0..1, r, g, b] (0..255). */
type ColorStop = readonly [number, number, number, number];

/** Black → mid-green → bright lime, useful for monochrome spectrograms. */
export const GREEN_PALETTE: Array<readonly [number, number, number, number]> = [
  [0,    0,   0,   0],
  [0.25, 0,  40,  10],
  [0.5,  0, 110,  30],
  [0.75, 60, 210, 80],
  [1,   200, 255, 150],
];

export const PALETTES = {
  viridis: [[0,68,1,84],[0.25,59,82,139],[0.5,33,145,140],[0.75,94,201,98],[1,253,231,37]],
  inferno: [[0,0,0,4],[0.25,87,16,110],[0.5,188,55,84],[0.75,249,142,8],[1,252,255,164]],
  plasma:  [[0,13,8,135],[0.25,126,3,167],[0.5,204,71,120],[0.75,248,148,65],[1,240,249,33]],
  magma:   [[0,0,0,4],[0.25,80,18,123],[0.5,183,55,121],[0.75,251,135,97],[1,252,253,191]],
  turbo:   [[0,48,18,59],[0.17,50,100,254],[0.33,48,194,243],[0.5,105,242,128],[0.67,252,242,57],[0.83,243,109,15],[1,122,4,3]],
  jet:     [[0,0,0,131],[0.125,0,60,170],[0.375,5,255,255],[0.625,255,255,0],[0.875,250,0,0],[1,128,0,0]],
  gray:    [[0,0,0,0],[1,255,255,255]],
  kiwi:    [[0,0,0,0],[0.15,0,0,80],[0.3,0,80,160],[0.45,0,160,160],[0.6,160,200,0],[0.75,255,200,0],[0.9,255,80,0],[1,200,0,0]],
  green:   [[0,0,0,0],[0.25,0,40,10],[0.5,0,110,30],[0.75,60,210,80],[1,200,255,150]],
} as const satisfies Record<string, readonly ColorStop[]>;

export type PaletteName = keyof typeof PALETTES;

export function buildLUT(stops: readonly ColorStop[]): Uint32Array {
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) { lo = stops[k]; hi = stops[k + 1]; break; }
    }
    const span = hi[0] - lo[0] || 1;
    const f = (t - lo[0]) / span;
    const r = lo[1] + (hi[1] - lo[1]) * f;
    const g = lo[2] + (hi[2] - lo[2]) * f;
    const b = lo[3] + (hi[3] - lo[3]) * f;
    out[i] = (255 << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
  }
  return out;
}
