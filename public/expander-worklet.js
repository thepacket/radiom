/* AudioWorkletProcessor: EXP — downward audio expander / soft gate.
 *
 * Smoothly attenuates audio below an adaptive threshold instead of
 * cutting it hard like VAD does. The result is a "soft noise gate"
 * that fades down between voice / signal bursts and recovers as soon
 * as a signal returns.
 *
 * Algorithm — per-sample envelope follower:
 *
 *  1. Fast-attack / slow-release envelope follower tracks the audio
 *     amplitude.
 *  2. An adaptive noise floor (slow EMA) follows the envelope ONLY
 *     when the expander is in the "attenuating" region — so the floor
 *     doesn't drift up while a strong signal is passing through.
 *  3. Threshold = noise_floor · 10^(thresholdDb/20). Below threshold:
 *     gain = max(floor, (env/threshold)^(ratio − 1)).  At threshold,
 *     gain = 1 (smooth meet-up with the pass-through region).
 *  4. The actual output gain is smoothed with attack/release time
 *     constants so it doesn't pump or click.
 *
 * Parameters via processorOptions / port messages:
 *   enabled     : bool                  — pass-through when false
 *   thresholdDb : number, default 12    — open gate when envelope is
 *                                          > thresh dB above the
 *                                          adaptive noise floor; below
 *                                          that, attenuation applies.
 *   ratio       : number, default 2     — downward ratio. 1.0 = no
 *                                          effect (off), 2 = soft,
 *                                          4 = aggressive.
 *   floorDb     : number, default −24   — minimum gain in dB (cap on
 *                                          how far the expander can
 *                                          attenuate).
 *
 * Latency: 0 (per-sample envelope-driven gain). Decision is one
 * sample behind, inaudible.
 */

const ATTACK_MS    = 3;
const RELEASE_MS   = 80;
const ALPHA_NOISE  = 0.005;     // slow noise-floor EMA when below threshold
const FLOOR_INIT   = 1e-4;
const GAIN_ATTACK_MS  = 5;
const GAIN_RELEASE_MS = 60;

class ExpanderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = (options && options.processorOptions) || {};
    this.enabled    = !!p.enabled;
    this.thresholdDb = typeof p.thresholdDb === 'number' ? p.thresholdDb : 12;
    this.ratio      = typeof p.ratio       === 'number' ? p.ratio       : 2;
    this.floorDb    = typeof p.floorDb     === 'number' ? p.floorDb     : -24;

    const fs = sampleRate;
    this.envAttack  = 1 - Math.exp(-1 / (fs * ATTACK_MS    / 1000));
    this.envRelease = 1 - Math.exp(-1 / (fs * RELEASE_MS   / 1000));
    this.gainAttack = 1 - Math.exp(-1 / (fs * GAIN_ATTACK_MS  / 1000));
    this.gainRel    = 1 - Math.exp(-1 / (fs * GAIN_RELEASE_MS / 1000));

    this.env        = 0;        // amplitude envelope
    this.gain       = 1;        // smoothed gain (audible)
    this.noiseFloor = FLOOR_INIT;

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (typeof m.enabled === 'boolean') this.enabled = m.enabled;
      if (typeof m.thresholdDb === 'number') {
        this.thresholdDb = Math.max(0, Math.min(30, m.thresholdDb));
      }
      if (typeof m.ratio === 'number') {
        this.ratio = Math.max(1, Math.min(10, m.ratio));
      }
      if (typeof m.floorDb === 'number') {
        this.floorDb = Math.max(-60, Math.min(0, m.floorDb));
      }
      if (m.type === 'reset') {
        this.env = 0; this.gain = 1;
        this.noiseFloor = FLOOR_INIT;
      }
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const N = out.length;

    if (!inp || !this.enabled || this.ratio <= 1) {
      for (let i = 0; i < N; i++) out[i] = inp ? inp[i] : 0;
      this.gain = 1;
      return true;
    }

    const eA = this.envAttack, eR = this.envRelease;
    const gA = this.gainAttack, gR = this.gainRel;
    const threshLin = Math.pow(10, this.thresholdDb / 20);
    const floorLin  = Math.pow(10, this.floorDb / 20);
    const expExp    = this.ratio - 1;

    for (let i = 0; i < N; i++) {
      const x = inp[i];
      const a = x >= 0 ? x : -x;
      // Envelope: fast on rises, slow on falls.
      if (a > this.env) this.env += eA * (a - this.env);
      else              this.env += eR * (a - this.env);

      const threshold = threshLin * this.noiseFloor;
      let gTarget;
      if (this.env >= threshold) {
        gTarget = 1;
      } else {
        // Smooth attenuation below threshold.
        const ratio = this.env / Math.max(1e-12, threshold);     // 0..1
        gTarget = Math.max(floorLin, Math.pow(ratio, expExp));
      }

      // Smoothed audible gain.
      if (gTarget > this.gain) this.gain += gA * (gTarget - this.gain);
      else                     this.gain += gR * (gTarget - this.gain);

      // Adapt noise floor only when below threshold (gate "closed-ish")
      // so a passing signal doesn't inflate the floor.
      if (this.env < threshold) {
        this.noiseFloor = (1 - ALPHA_NOISE) * this.noiseFloor + ALPHA_NOISE * this.env;
        if (this.noiseFloor < FLOOR_INIT) this.noiseFloor = FLOOR_INIT;
      }

      out[i] = x * this.gain;
    }
    return true;
  }
}

registerProcessor('expander', ExpanderProcessor);
