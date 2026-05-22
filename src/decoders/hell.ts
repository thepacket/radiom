/** Feld-Hellschreiber visual renderer.
 *
 *  Hellschreiber is a 1929 text-by-image mode: characters are drawn as
 *  a 7-column × 14-row raster of black/white pixels and sent via OOK
 *  keying of an audio carrier. Each pixel is ~8.16 ms long (122.5
 *  baud); a character takes ~400 ms (49 pixels × 2-line scan). There
 *  is *no decoding to ASCII* — the operator reads the rendered image
 *  by eye, exactly like an old paper-tape printer.
 *
 *  Our implementation is the simplest viable thing:
 *
 *    1. Bandpass the demodulated SSB audio around the tuned audio
 *       offset (default 1000 Hz, ±100 Hz) to isolate the carrier.
 *    2. Take the envelope (|s| smoothed) so ON / OFF keying becomes a
 *       baseband signal.
 *    3. Sample the envelope at the pixel clock (122.5 baud → one
 *       column every ~98 samples at 12 kHz).
 *    4. Paint each column on a 14-row-tall canvas. The two interlaced
 *       scan lines per character would normally produce a slight
 *       vertical doubling — we paint both halves so the operator sees
 *       the classic Feld-Hell look.
 *
 *  The renderer auto-normalises the column intensity against a rolling
 *  min/max so AGC drifts don't make the image fade out. */

const SAMPLE_RATE = 12_000;
const PIXEL_RATE_HZ = 122.5;        // Feld-Hell standard
const SAMPLES_PER_PIXEL = SAMPLE_RATE / PIXEL_RATE_HZ; // ≈97.96

export interface HellOpts {
  /** Audio carrier centre, Hz. Default 1000. Operator should tune so
   *  the carrier sits roughly here. */
  audioCenterHz?: number;
  /** Output column callback — receives a Float32Array of 14 values in
   *  0..1 (black=1, white=0) plus a wall-clock timestamp. The shell
   *  blits this to a scrolling canvas. */
  onColumn?: (col: Float32Array, tsMs: number) => void;
}

export class HellDecoder {
  private opts: HellOpts;
  private centerHz: number;
  /** Quadrature mixer state for the carrier shift. */
  private mixPhase = 0;
  /** Real-pole low-pass after the mixer; produces the envelope. */
  private lpRe = 0;
  private lpIm = 0;
  /** Accumulator for averaging samples into one pixel column. */
  private pxAcc = 0;
  private pxCount = 0;
  /** Fractional sample position within the current pixel — used so
   *  pixels stay phase-locked even though SAMPLES_PER_PIXEL isn't an
   *  integer (97.96). */
  private pxPhase = 0;
  /** Rolling min/max for column normalisation; bleeds back toward
   *  centre on every column so transient bursts don't permanently
   *  saturate the scale. */
  private envMin = 1.0;
  private envMax = 0.0;

  constructor(opts: HellOpts = {}) {
    this.opts = opts;
    this.centerHz = opts.audioCenterHz ?? 1000;
  }

  feed(samples: Int16Array): void {
    const w = (2 * Math.PI * this.centerHz) / SAMPLE_RATE;
    // Single-pole LP cutoff ≈ 200 Hz on the I/Q outputs gives us a
    // clean envelope without smearing the 122.5 Hz pixel transitions.
    const alpha = 1 - Math.exp(-2 * Math.PI * 200 / SAMPLE_RATE);
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] / 32768;
      const c = Math.cos(this.mixPhase);
      const s = Math.sin(this.mixPhase);
      this.mixPhase += w;
      if (this.mixPhase > 2 * Math.PI) this.mixPhase -= 2 * Math.PI;
      const ire = x * c;
      const iim = -x * s;
      this.lpRe += alpha * (ire - this.lpRe);
      this.lpIm += alpha * (iim - this.lpIm);
      const env = Math.sqrt(this.lpRe * this.lpRe + this.lpIm * this.lpIm);
      this.pxAcc += env;
      this.pxCount++;
      this.pxPhase += 1;
      if (this.pxPhase >= SAMPLES_PER_PIXEL) {
        this.pxPhase -= SAMPLES_PER_PIXEL;
        const avg = this.pxCount > 0 ? this.pxAcc / this.pxCount : 0;
        this.pxAcc = 0;
        this.pxCount = 0;
        this.emitColumn(avg);
      }
    }
  }

  private emitColumn(env: number): void {
    // Rolling min/max with light decay — pulls back toward the running
    // mean by ~1% per column so old bursts let go of the scale after
    // ~100 columns (~800 ms).
    this.envMin = Math.min(this.envMin, env) * 0.99 + env * 0.01;
    this.envMax = Math.max(this.envMax, env) * 0.99 + env * 0.01;
    // Snap min/max when they cross (e.g. silent channel) so the
    // displayed image doesn't blow up to noise.
    if (this.envMax - this.envMin < 1e-4) { this.envMin = 0; this.envMax = 1; }
    const t = Math.max(0, Math.min(1, (env - this.envMin) / (this.envMax - this.envMin)));
    // Each Hellschreiber column is the same value top-to-bottom — the
    // 14-row "image" is a vertical bar of one intensity, and only as
    // successive columns arrive does the character take shape. Build
    // a 14-row vector for the shell to blit.
    const col = new Float32Array(14);
    col.fill(t);
    this.opts.onColumn?.(col, Date.now());
  }

  setAudioCenter(hz: number): void {
    this.centerHz = hz;
    this.mixPhase = 0;
    this.lpRe = 0;
    this.lpIm = 0;
  }

  close(): void { /* no-op — purely synchronous DSP, no timers to cancel */ }
}
