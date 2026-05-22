/* AudioWorkletProcessor: pull-side ring buffer fed by main thread.
 * Main thread posts Float32Array chunks already resampled to ctx.sampleRate.
 * Underrun → silence (no glitchy repeat).
 */
class KiwiPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 1 second @ 48kHz worth of headroom; grows if needed.
    this.cap = 48000;
    this.buf = new Float32Array(this.cap);
    this.r = 0; // read index
    this.w = 0; // write index
    this.size = 0;
    this.gain = 1;
    this.muted = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'samples') this.push(m.data);
      else if (m.type === 'gain') this.gain = m.value;
      else if (m.type === 'mute') this.muted = !!m.value;
      else if (m.type === 'flush') {
        // Optional `keep` (in samples) preserves the most recent tail so
        // playback doesn't underrun-glitch on user-initiated flushes.
        const keep = m.keep | 0;
        if (this.size > keep) {
          const drop = this.size - keep;
          this.r = (this.r + drop) % this.cap;
          this.size = keep;
        }
      }
    };
  }

  push(arr) {
    if (this.size + arr.length > this.cap) this.grow(this.size + arr.length);
    for (let i = 0; i < arr.length; i++) {
      this.buf[this.w] = arr[i];
      this.w = (this.w + 1) % this.cap;
    }
    this.size += arr.length;
  }

  grow(min) {
    let newCap = this.cap;
    while (newCap < min) newCap *= 2;
    const nb = new Float32Array(newCap);
    for (let i = 0; i < this.size; i++) nb[i] = this.buf[(this.r + i) % this.cap];
    this.buf = nb; this.cap = newCap; this.r = 0; this.w = this.size;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    if (this.muted || this.size < n) {
      out.fill(0);
      // Drain partial if we have some, zero rest, to avoid permanent stall.
      if (!this.muted && this.size > 0) {
        for (let i = 0; i < this.size && i < n; i++) {
          out[i] = this.buf[this.r] * this.gain;
          this.r = (this.r + 1) % this.cap;
        }
        this.size = 0;
      }
      return true;
    }
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[this.r] * this.gain;
      this.r = (this.r + 1) % this.cap;
    }
    this.size -= n;
    return true;
  }
}

registerProcessor('kiwi-pcm', KiwiPcmProcessor);
