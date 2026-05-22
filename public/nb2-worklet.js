/* AudioWorkletProcessor: NB2 — port of Warren Pratt's WDSP NB2.
 *
 * Impulse-noise blanker for the audio domain. Operates on mono float32
 * at the AudioContext sample rate (typically 48 kHz).
 *
 * Algorithm (faithful to WDSP's nob.c):
 *
 *  1. Maintain a running estimate of the signal envelope's "noise floor"
 *     via an asymmetric leaky integrator (fast attack on rises, slow
 *     decay otherwise). This is the *adaptive threshold reference*.
 *
 *  2. Each incoming sample's |x| is compared against K × reference.
 *     When |x| > K · ref the sample is flagged as part of an impulse.
 *
 *  3. The output reads from a delay line that lags the input by
 *     `advTime` samples. When an impulse is detected on the *input*,
 *     the output is `advTime` samples behind — exactly the time we
 *     need to smoothly fade the output to zero (via a raised-cosine
 *     taper) before the impulse propagates through.
 *
 *  4. State machine:
 *       NORMAL    → output = delayed · 1
 *       FADE_OUT  → output = delayed · cos²(…)   (advTime samples)
 *       BLANK     → output = 0                    (hangTime samples)
 *       FADE_IN   → output = delayed · cos²(…)   (advTime samples)
 *       → NORMAL
 *
 *     If a fresh impulse is detected while in BLANK, the hangTime
 *     counter resets — the blank period extends to cover the new pulse.
 *
 *  5. Two thresholds in the rise integrator: a fast track (attack
 *     τ ≈ 5 ms) so a sudden noise burst lifts the reference before
 *     a second impulse 10 ms later is wrongly blanked, and a slow
 *     decay (τ ≈ 500 ms) so the reference doesn't bounce back down
 *     between impulses in a noisy band.
 *
 * Parameters via processorOptions / port messages:
 *  enabled : bool — pass-through when false
 *  k       : number — threshold multiplier (typical 3 / 5 / 7)
 *
 * Latency: `advTime` samples (~0.3 ms at 48 kHz). Inaudible.
 */

const ADV_MS  = 0.3;   // fade in/out duration, ms
const HANG_MS = 1.5;   // blank hold, ms
const TAU_FAST_MS = 5;
const TAU_SLOW_MS = 500;

class NB2Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = (options && options.processorOptions) || {};
    this.enabled = !!p.enabled;
    this.K = typeof p.k === 'number' ? Math.max(2, Math.min(15, p.k)) : 5.0;

    const fs = sampleRate;
    this.advTime = Math.max(1, Math.round(fs * ADV_MS / 1000));
    this.hangTime = Math.max(1, Math.round(fs * HANG_MS / 1000));
    this.alphaFast = 1 - Math.exp(-1 / (fs * TAU_FAST_MS / 1000));
    this.alphaSlow = 1 - Math.exp(-1 / (fs * TAU_SLOW_MS / 1000));

    // Raised-cosine taper, 0 → 1 over advTime samples. coef[0]=0, coef[advTime-1]≈1.
    this.coef = new Float32Array(this.advTime);
    for (let i = 0; i < this.advTime; i++) {
      const t = i / Math.max(1, this.advTime - 1);
      this.coef[i] = 0.5 * (1 - Math.cos(Math.PI * t));
    }

    // Delay line — output reads `advTime` samples behind input.
    this.dlineSize = this.advTime + 4;
    this.dline = new Float32Array(this.dlineSize);
    this.head = 0;

    // Adaptive noise-floor reference.
    this.ref = 1e-6;

    // States.
    this.NORMAL = 0; this.FADE_OUT = 1; this.BLANK = 2; this.FADE_IN = 3;
    this.state = this.NORMAL;
    this.count = 0;

    // Diagnostic counters.
    this.blanked = 0;

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (typeof m.enabled === 'boolean') this.enabled = m.enabled;
      if (typeof m.k === 'number') this.K = Math.max(2, Math.min(15, m.k));
      if (m.type === 'reset') {
        this.dline.fill(0); this.head = 0; this.ref = 1e-6;
        this.state = this.NORMAL; this.count = 0; this.blanked = 0;
      }
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const N = out.length;

    if (!inp || !this.enabled) {
      for (let i = 0; i < N; i++) out[i] = inp ? inp[i] : 0;
      return true;
    }

    const adv = this.advTime, sz = this.dlineSize;
    const aFast = this.alphaFast, aSlow = this.alphaSlow;

    for (let i = 0; i < N; i++) {
      const x = inp[i];
      const env = x >= 0 ? x : -x;

      // Adaptive reference: fast on rise, slow on fall.
      if (env > this.ref) {
        this.ref += aFast * (env - this.ref);
      } else {
        this.ref += aSlow * (env - this.ref);
      }

      // Push into delay line; output reads `adv` samples behind.
      const writeIdx = this.head;
      this.dline[writeIdx] = x;
      this.head = (this.head + 1) % sz;
      const readIdx = (this.head + sz - adv) % sz;
      const delayed = this.dline[readIdx];

      // Impulse detection on the *current* (un-delayed) sample so we
      // have `adv` samples of look-ahead before the impulse reaches output.
      const over = env > this.K * this.ref;

      let gain = 1.0;
      switch (this.state) {
        case this.NORMAL:
          if (over) {
            this.state = this.FADE_OUT;
            this.count = adv;
          }
          break;
        case this.FADE_OUT:
          // count = adv→1 → gain = coef[count-1] fades 1→0.
          gain = this.coef[adv - this.count];
          this.count--;
          if (this.count <= 0) {
            this.state = this.BLANK;
            this.count = this.hangTime;
          }
          break;
        case this.BLANK:
          gain = 0;
          if (over) {
            // Extend blank — reset hang counter.
            this.count = this.hangTime;
            this.blanked++;
          } else {
            this.count--;
            if (this.count <= 0) {
              this.state = this.FADE_IN;
              this.count = 0;
            }
          }
          break;
        case this.FADE_IN:
          gain = this.coef[this.count];
          this.count++;
          if (this.count >= adv) {
            this.state = this.NORMAL;
          }
          break;
      }

      out[i] = delayed * gain;
    }
    return true;
  }
}

registerProcessor('nb2', NB2Processor);
