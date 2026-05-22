/* AudioWorkletProcessor: Hampel-filter de-clicker / sferic suppressor.
 *
 * For every output sample we look at a small window centred on it
 * (WIN samples total, WIN_HALF each side). If the centre sample is
 * more than `k × 1.4826 × MAD` away from the window median, it's
 * considered an outlier (lightning crash, ignition noise, switching
 * spike, etc.) and replaced with the median. Otherwise it passes
 * through unchanged.
 *
 *   MAD = median(|x_i − median(x)|) — a robust scale estimator that
 *   ignores the outliers we're trying to detect.
 *   1.4826 makes MAD a consistent estimator of σ for Gaussian data.
 *
 * Latency: WIN_HALF samples (≈ 208 µs at 48 kHz). Inaudible.
 *
 * When `enabled` is false the processor is a pure pass-through.
 */
const WIN = 21;
const WIN_HALF = 10;
const MAD_TO_SIGMA = 1.4826;

class DeClickerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.enabled = !!opts.enabled;
    // Detection threshold in σ-equivalents. 3.0 is the classical
    // outlier cutoff; lower = more aggressive (catches softer ticks).
    this.k = typeof opts.k === 'number'
      ? Math.max(1.5, Math.min(10, opts.k))
      : 3.0;

    this.delay   = new Float32Array(WIN);
    this.scratch = new Float32Array(WIN);
    this.devbuf  = new Float32Array(WIN);
    this.dpos    = 0;
    this.warmup  = 0;
    // For diagnostics: number of replacements since last reset.
    this.replaced = 0;

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (typeof m.enabled === 'boolean') this.enabled = m.enabled;
      if (typeof m.k === 'number') this.k = Math.max(1.5, Math.min(10, m.k));
      if (m.type === 'reset') {
        this.delay.fill(0); this.dpos = 0; this.warmup = 0; this.replaced = 0;
      }
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = out.length;

    if (!inp || !this.enabled) {
      for (let i = 0; i < n; i++) out[i] = inp ? inp[i] : 0;
      return true;
    }

    const win = this.scratch;
    const dev = this.devbuf;
    const k = this.k;

    for (let i = 0; i < n; i++) {
      this.delay[this.dpos] = inp[i];
      this.dpos = (this.dpos + 1) % WIN;

      if (this.warmup < WIN) {
        this.warmup++;
        out[i] = 0;     // briefly silent during initial fill
        continue;
      }

      // Linearise ring: oldest → newest. After advancing dpos, the
      // next-write slot holds the *oldest* sample, so the linearisation
      // starts there.
      for (let j = 0; j < WIN; j++) {
        win[j] = this.delay[(this.dpos + j) % WIN];
      }
      const x = win[WIN_HALF];

      // Median(x).
      win.sort();
      const median = win[WIN_HALF];

      // Median(|x_i − median|) → MAD.
      for (let j = 0; j < WIN; j++) dev[j] = Math.abs(win[j] - median);
      dev.sort();
      const mad = dev[WIN_HALF];
      const threshold = k * MAD_TO_SIGMA * mad;

      if (threshold > 1e-10 && Math.abs(x - median) > threshold) {
        out[i] = median;
        this.replaced++;
      } else {
        out[i] = x;
      }
    }
    return true;
  }
}

registerProcessor('declicker', DeClickerProcessor);
