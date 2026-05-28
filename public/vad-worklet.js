/* AudioWorkletProcessor: VAD — Voice Activity Detector / audio gate.
 *
 * Gates the audio output open when voice-like activity is detected and
 * closed otherwise. Smarter than a plain RSSI / amplitude squelch: a
 * pure carrier or white-noise blast won't open the gate; only signals
 * with voice-characteristic energy + zero-crossing rate do.
 *
 * Algorithm — frame-by-frame, FRAME_MS = 10 ms:
 *
 *  1. RMS energy of the frame, normalised against an adaptive noise
 *     floor that is itself updated (slow EMA) only when the gate is
 *     closed — so the floor doesn't drift up while the operator is
 *     speaking.
 *  2. Zero-crossing rate (ZCR) of the frame. Voice ZCR is roughly
 *     0.02 – 0.30 of the frame length. Pure tones sit below; white
 *     noise sits above.
 *  3. A frame counts as "energetic & voice-like" when:
 *         rms > threshold_dB · noise_floor   AND
 *         0.01 < zcr < 0.35
 *  4. ATTACK_FRAMES consecutive energetic frames open the gate.
 *     After that, the gate STAYS open for hang_ms even on silent
 *     frames (so the operator's pauses don't clip).
 *  5. Output gain is ramped smoothly toward the target (0 or 1) over
 *     RAMP_MS to avoid clicks at the gate edges.
 *
 * Parameters via processorOptions / port messages:
 *   enabled     : bool                 — pass-through when false
 *   thresholdDb : number, default 6    — open gate when frame RMS is
 *                                         > thresh dB above the noise
 *                                         floor. 6 dB = aggressive,
 *                                         12 dB = relaxed (less false
 *                                         opening).
 *   hangMs      : number, default 300  — gate stays open this long
 *                                         after the last energetic
 *                                         frame.
 *   type:'reset'                       — clear noise floor + state.
 *
 * Latency: 0. (Per-sample gain is applied immediately.) The decision
 * is one frame behind, which is at most FRAME_MS = 10 ms — inaudible.
 */

const FRAME_MS         = 10;
const ATTACK_FRAMES    = 2;     // 20 ms of energetic frames to open
const HANG_MS_DEFAULT  = 300;
const RAMP_MS          = 8;
const NOISE_FLOOR_INIT = 1e-4;
const ALPHA_NOISE      = 0.02;  // EMA rate of the noise-floor tracker
const ZCR_MIN          = 0.01;
const ZCR_MAX          = 0.35;

class VadProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = (options && options.processorOptions) || {};
    this.enabled = !!p.enabled;
    this.hangMs = typeof p.hangMs === 'number' ? p.hangMs : HANG_MS_DEFAULT;
    this.thresholdDb = typeof p.thresholdDb === 'number' ? p.thresholdDb : 6;

    const fs = sampleRate;
    this.frameLen   = Math.max(16, Math.round(fs * FRAME_MS / 1000));
    this.hangFrames = Math.max(1,  Math.round(this.hangMs / FRAME_MS));
    this.rampStep   = 1 / Math.max(1, Math.round(fs * RAMP_MS / 1000));

    this.noiseFloor    = NOISE_FLOOR_INIT;
    this.frameAcc      = 0;
    this.frameSum2     = 0;
    this.frameZc       = 0;
    this.prevSign      = 0;
    this.energeticStreak = 0;
    this.hangCounter   = 0;
    this.voiceActive   = false;
    this.gain          = 0;
    this.gainTarget    = 0;

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (typeof m.enabled === 'boolean') this.enabled = m.enabled;
      if (typeof m.hangMs === 'number') {
        this.hangMs = Math.max(50, Math.min(2000, m.hangMs));
        this.hangFrames = Math.max(1, Math.round(this.hangMs / FRAME_MS));
      }
      if (typeof m.thresholdDb === 'number') {
        this.thresholdDb = Math.max(0, Math.min(30, m.thresholdDb));
      }
      if (m.type === 'reset') {
        this.noiseFloor = NOISE_FLOOR_INIT;
        this.frameAcc = 0; this.frameSum2 = 0; this.frameZc = 0;
        this.energeticStreak = 0; this.hangCounter = 0;
        this.voiceActive = false;
        this.gain = 0; this.gainTarget = 0;
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
      // Keep gain coherent for the moment the user re-enables.
      this.gain = 1;
      this.gainTarget = 1;
      return true;
    }

    const threshAmp = Math.pow(10, this.thresholdDb / 20);
    const step = this.rampStep;

    for (let i = 0; i < N; i++) {
      const x = inp[i];
      this.frameSum2 += x * x;
      const sign = x >= 0 ? 1 : -1;
      if (this.prevSign !== 0 && sign !== this.prevSign) this.frameZc++;
      this.prevSign = sign;
      this.frameAcc++;

      if (this.frameAcc >= this.frameLen) {
        const rms = Math.sqrt(this.frameSum2 / this.frameAcc);
        const zcr = this.frameZc / this.frameAcc;
        const energetic = rms > threshAmp * this.noiseFloor;
        const voicelike = zcr > ZCR_MIN && zcr < ZCR_MAX;

        if (energetic && voicelike) {
          this.energeticStreak++;
          if (this.energeticStreak >= ATTACK_FRAMES) {
            this.voiceActive = true;
            this.hangCounter = this.hangFrames;
          }
        } else {
          this.energeticStreak = 0;
          if (this.voiceActive) {
            this.hangCounter--;
            if (this.hangCounter <= 0) this.voiceActive = false;
          }
        }

        // Adapt noise floor only when gate is closed — keeps the floor
        // honest about background noise without being inflated by voice.
        if (!this.voiceActive) {
          this.noiseFloor = (1 - ALPHA_NOISE) * this.noiseFloor + ALPHA_NOISE * rms;
          if (this.noiseFloor < NOISE_FLOOR_INIT) this.noiseFloor = NOISE_FLOOR_INIT;
        }

        this.gainTarget = this.voiceActive ? 1 : 0;

        this.frameAcc = 0;
        this.frameSum2 = 0;
        this.frameZc = 0;
      }

      // Smooth the actual gain toward the target.
      if (this.gain < this.gainTarget)      this.gain = Math.min(this.gainTarget, this.gain + step);
      else if (this.gain > this.gainTarget) this.gain = Math.max(this.gainTarget, this.gain - step);

      out[i] = x * this.gain;
    }

    return true;
  }
}

registerProcessor('vad', VadProcessor);
