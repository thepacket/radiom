/* AudioWorkletProcessor: PSHIFT — two-pointer crossfade pitch shifter.
 *
 * Real-time pitch shifter for the demod-audio path. Operates on mono
 * float32 at the AudioContext sample rate.
 *
 * Algorithm (classic delay-line pitch shifter, "Doppler trick"):
 *
 *  1. Maintain a circular buffer of M samples (BUF_SIZE).
 *  2. Write the live input into the buffer at write-pointer rate 1.
 *  3. Two READ pointers move at a different rate `ratio = 2^(semi/12)`:
 *       - ratio > 1 → reads faster than writes → buffer is sampled at
 *         a compressed rate, output sounds higher in pitch
 *       - ratio < 1 → reads slower than writes → output sounds lower
 *  4. The two read pointers are 180° apart in the buffer. As each read
 *     pointer drifts toward the write pointer, fade it down and the
 *     other up. This produces continuous output without the discontinu-
 *     ity that a single read-pointer would create at wrap-around.
 *  5. Linear interpolation between buffer samples because read pointers
 *     are fractional.
 *
 * Trade-offs:
 *  - Simpler and CPU-cheaper than a phase-vocoder
 *  - Adds chorus-like artifacts on transients at large pitch shifts
 *  - Glitch-free; degrades smoothly rather than failing
 *
 * Why "time stretch" isn't a separate filter here: a live AudioWorklet
 * has input-rate = output-rate (the AudioContext clock). True
 * time-stretching (output longer than input while preserving pitch)
 * would require an unbounded growing buffer — not a real-time filter.
 * The pitch shifter does provide a useful proxy: drop pitch by 6 or
 * 12 semitones to make fast CW easier to follow.
 *
 * Parameters via processorOptions / port messages:
 *   enabled  : bool — pass-through when false
 *   semitones: number in [-12, +12]
 *
 * Latency: roughly BUF_SIZE / 2 samples of look-ahead (~40 ms at
 * 48 kHz).  Inaudible for listening; not suitable for two-way comms.
 */

const BUF_SIZE   = 4096;       // ~85 ms at 48 kHz
const FADE_WIDTH = 256;        // samples of crossfade as read approaches write

class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = (options && options.processorOptions) || {};
    this.enabled = !!p.enabled;
    this.setSemitones(typeof p.semitones === 'number' ? p.semitones : 0);

    this.buf = new Float32Array(BUF_SIZE);
    this.writeIdx = 0;
    this.read1 = 0;
    this.read2 = BUF_SIZE / 2;

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (typeof m.enabled === 'boolean') this.enabled = m.enabled;
      if (typeof m.semitones === 'number') this.setSemitones(m.semitones);
      if (m.type === 'reset') {
        this.buf.fill(0);
        this.writeIdx = 0;
        this.read1 = 0;
        this.read2 = BUF_SIZE / 2;
      }
    };
  }

  setSemitones(s) {
    s = Math.max(-12, Math.min(12, s));
    this.semitones = s;
    this.ratio = Math.pow(2, s / 12);   // playback rate of the read head
  }

  // Crossfade factor: 1 in the middle of the read run, fades to 0 as the
  // read pointer comes within FADE_WIDTH of the write pointer (the "wrap
  // zone"). Returning a small floor (0.01) avoids divide-by-zero when
  // both pointers happen to be near the write head simultaneously.
  fadeFactor(readIdx, writeIdx) {
    // Unsigned distance from the read pointer to the *next* write — i.e.
    // how many fresh samples we have before the write head laps us.
    let dist = (writeIdx - readIdx + BUF_SIZE) % BUF_SIZE;
    if (dist > BUF_SIZE - FADE_WIDTH) {
      // Read pointer is right *behind* the write — short remaining
      // window before lap. Fade out.
      return (BUF_SIZE - dist) / FADE_WIDTH;
    }
    if (dist < FADE_WIDTH) {
      // Read pointer is right ahead of the write — wrapped fresh, fade in.
      return dist / FADE_WIDTH;
    }
    return 1;
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const N = out.length;

    if (!inp || !this.enabled || this.semitones === 0) {
      for (let i = 0; i < N; i++) out[i] = inp ? inp[i] : 0;
      return true;
    }

    const ratio = this.ratio;
    const buf = this.buf;

    for (let i = 0; i < N; i++) {
      // Write the live sample.
      buf[this.writeIdx] = inp[i];
      this.writeIdx = (this.writeIdx + 1) % BUF_SIZE;

      // Linear interp at read1.
      const i1f = Math.floor(this.read1);
      const i1n = (i1f + 1) % BUF_SIZE;
      const f1  = this.read1 - i1f;
      const s1  = buf[i1f] * (1 - f1) + buf[i1n] * f1;

      // Linear interp at read2.
      const i2f = Math.floor(this.read2);
      const i2n = (i2f + 1) % BUF_SIZE;
      const f2  = this.read2 - i2f;
      const s2  = buf[i2f] * (1 - f2) + buf[i2n] * f2;

      // Crossfade by distance-to-write.
      const w1 = this.fadeFactor(this.read1, this.writeIdx);
      const w2 = this.fadeFactor(this.read2, this.writeIdx);
      const wsum = w1 + w2;
      out[i] = wsum > 1e-6 ? (s1 * w1 + s2 * w2) / wsum : 0;

      // Advance both read heads.
      this.read1 += ratio;
      this.read2 += ratio;
      while (this.read1 >= BUF_SIZE) this.read1 -= BUF_SIZE;
      while (this.read1 < 0)         this.read1 += BUF_SIZE;
      while (this.read2 >= BUF_SIZE) this.read2 -= BUF_SIZE;
      while (this.read2 < 0)         this.read2 += BUF_SIZE;
    }
    return true;
  }
}

registerProcessor('pitch-shift', PitchShiftProcessor);
