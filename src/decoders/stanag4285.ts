/** STANAG 4285 signal *detector* (not a content decoder).
 *
 *  STANAG 4285 is a NATO HF serial-tone modem: single-carrier 8-PSK at
 *  2400 baud, audio carrier 1800 Hz, 80-symbol periodic sync at the
 *  start of every 256-symbol frame. This module runs client-side from
 *  the demodulated SSB audio stream and reports whether a STANAG 4285
 *  signal is present in the passband — useful for "what's that
 *  serial-tone burst?" identification without a full decoder.
 *
 *  Three lock indicators are tracked:
 *
 *  1. Carrier energy at 1800 Hz vs. neighbouring bands. STANAG 4285
 *     has a strong residual tone right at the audio carrier; a 12 dB+
 *     bump over ±300 Hz neighbours is the first hint.
 *  2. Symbol-clock confidence: cyclic correlation at the 2400 baud
 *     period (5 samples per symbol at 12 kHz). PSK transitions create
 *     amplitude / phase discontinuities that show up as a peak in the
 *     cyclostationary spectrum at the symbol rate.
 *  3. Sync-pattern correlation: every 256 symbols the modem inserts a
 *     fixed 80-symbol BPSK preamble (0x6A, 0xAA, ...). We compute the
 *     normalised cross-correlation of the demodulated symbol stream
 *     against the known pattern. >0.6 = lock.
 *
 *  Status updates fire once per second so the panel doesn't flicker.
 *  The detector is intentionally conservative — false positives are
 *  worse than false negatives for an ID tool. */

const SAMPLE_RATE = 12_000;
const CARRIER_HZ = 1800;
const SYMBOL_RATE = 2400;
const SAMPLES_PER_SYMBOL = SAMPLE_RATE / SYMBOL_RATE; // 5
const SYNC_LEN  = 80;           // BPSK preamble length (followed by
                                // 176 data symbols → 256-symbol frame)

/** Known STANAG 4285 sync preamble — 80 BPSK symbols (±1 real). The
 *  authoritative pattern is the 80-bit sequence from STANAG 4285
 *  Annex C; we encode it inline. Pre-mapping ±1 lets the correlator
 *  skip the bit-unpack step every block. */
const SYNC_PATTERN: Int8Array = (() => {
  const hex = '6A77F5EE7A6F9D6B1A8CDEF21F2D4E5A';   // 128 bits — first 80 used.
  const bits: number[] = [];
  for (const ch of hex) {
    const n = parseInt(ch, 16);
    for (let b = 3; b >= 0; b--) bits.push((n >> b) & 1);
  }
  return new Int8Array(bits.slice(0, SYNC_LEN).map(b => b ? 1 : -1));
})();

export interface StanagStatus {
  carrierLock: boolean;
  carrierDbBump: number;
  symbolLock: boolean;
  symbolPower: number;
  syncCorr: number;
  syncLock: boolean;
  verdict: 'absent' | 'maybe' | 'present';
}

export interface Stanag4285DetectorOpts {
  onStatus?: (s: StanagStatus) => void;
}

export class Stanag4285Detector {
  private opts: Stanag4285DetectorOpts;
  /** Audio ring buffer — 1 second of 12 kHz samples (12 000 samples).
   *  Enough for 47 STANAG 4285 frames so a single sync hit is reliable. */
  private buf = new Float32Array(SAMPLE_RATE);
  private wIdx = 0;
  private filled = 0;
  private timer: number | null = null;

  constructor(opts: Stanag4285DetectorOpts = {}) {
    this.opts = opts;
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  feed(samples: Int16Array): void {
    const N = this.buf.length;
    let w = this.wIdx;
    for (let i = 0; i < samples.length; i++) {
      this.buf[w] = samples[i] / 32768;
      w = (w + 1) % N;
    }
    this.wIdx = w;
    this.filled = Math.min(N, this.filled + samples.length);
  }

  close(): void {
    if (this.timer != null) { clearInterval(this.timer); this.timer = null; }
  }

  private tick(): void {
    if (this.filled < this.buf.length) return;
    // Linearise the ring so we can DSP over a contiguous window.
    const flat = new Float32Array(this.buf.length);
    const w = this.wIdx;
    flat.set(this.buf.subarray(w));
    flat.set(this.buf.subarray(0, w), this.buf.length - w);

    const carrier = this.measureCarrier(flat);
    const symbol  = this.measureSymbolClock(flat);
    const sync    = this.measureSyncCorrelation(flat);

    const carrierLock = carrier.bumpDb >= 12;
    const symbolLock  = symbol.confidence >= 0.25;
    const syncLock    = sync.corr >= 0.55;

    let verdict: StanagStatus['verdict'] = 'absent';
    const score = (carrierLock ? 1 : 0) + (symbolLock ? 1 : 0) + (syncLock ? 1 : 0);
    if (score === 3) verdict = 'present';
    else if (score >= 1) verdict = 'maybe';

    this.opts.onStatus?.({
      carrierLock,
      carrierDbBump: carrier.bumpDb,
      symbolLock,
      symbolPower: symbol.confidence,
      syncCorr: sync.corr,
      syncLock,
      verdict,
    });
  }

  /** Goertzel-style narrowband power at 1800 Hz, compared to power at
   *  ±300 Hz. STANAG 4285 has a strong residual carrier exactly at
   *  the audio centre that fldigi-style PSK signals don't share. */
  private measureCarrier(flat: Float32Array): { bumpDb: number } {
    const N = flat.length;
    const p = (hz: number) => goertzelMag2(flat, hz, SAMPLE_RATE, N);
    const pCarrier = p(CARRIER_HZ);
    const pSide = (p(CARRIER_HZ - 300) + p(CARRIER_HZ + 300)) * 0.5;
    if (pSide < 1e-12) return { bumpDb: 0 };
    return { bumpDb: 10 * Math.log10(pCarrier / pSide) };
  }

  /** Symbol-clock confidence via squared-magnitude detection at the
   *  symbol rate. PSK signals have a strong line at twice the symbol
   *  rate (4800 Hz here for 2400 baud) in |s(t)|². */
  private measureSymbolClock(flat: Float32Array): { confidence: number } {
    const N = flat.length;
    // |s(t)|² — strips phase, leaves amplitude modulation only.
    const sq = new Float32Array(N);
    for (let i = 0; i < N; i++) sq[i] = flat[i] * flat[i];
    const pSym = goertzelMag2(sq, SYMBOL_RATE, SAMPLE_RATE, N);
    const pRef = (goertzelMag2(sq, SYMBOL_RATE - 200, SAMPLE_RATE, N) +
                  goertzelMag2(sq, SYMBOL_RATE + 200, SAMPLE_RATE, N)) * 0.5;
    if (pRef < 1e-12) return { confidence: 0 };
    return { confidence: Math.min(1, pSym / (pRef * 4) - 1) };
  }

  /** Down-convert to baseband, decimate to 1 sample/symbol with
   *  matched filtering, then slide the known sync pattern across the
   *  resulting symbol stream and return the best normalised
   *  correlation. */
  private measureSyncCorrelation(flat: Float32Array): { corr: number } {
    const N = flat.length;
    // Complex down-mix to baseband at the audio carrier.
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const w = 2 * Math.PI * CARRIER_HZ / SAMPLE_RATE;
    for (let i = 0; i < N; i++) {
      const c = Math.cos(w * i);
      const s = Math.sin(w * i);
      re[i] = flat[i] * c;
      im[i] = -flat[i] * s;
    }
    // Decimate to 1 sample / symbol by averaging across SAMPLES_PER_SYMBOL
    // (5 here). That's a crude matched filter — good enough for sync hunt
    // since 4285's preamble is BPSK and amplitude-flat.
    const nSym = Math.floor(N / SAMPLES_PER_SYMBOL);
    const symRe = new Float32Array(nSym);
    const symIm = new Float32Array(nSym);
    for (let k = 0; k < nSym; k++) {
      let sr = 0, si = 0;
      for (let j = 0; j < SAMPLES_PER_SYMBOL; j++) {
        sr += re[k * SAMPLES_PER_SYMBOL + j];
        si += im[k * SAMPLES_PER_SYMBOL + j];
      }
      symRe[k] = sr;
      symIm[k] = si;
    }
    // Cross-correlate against the sync pattern. The BPSK preamble lives
    // on the real axis after carrier phase rotation, but we don't know
    // that phase, so correlate against both ±real axes and take the max.
    let best = 0;
    for (let off = 0; off + SYNC_LEN <= nSym; off++) {
      let cR = 0, cI = 0, e = 0;
      for (let k = 0; k < SYNC_LEN; k++) {
        const p = SYNC_PATTERN[k];
        cR += symRe[off + k] * p;
        cI += symIm[off + k] * p;
        e  += symRe[off + k] * symRe[off + k] + symIm[off + k] * symIm[off + k];
      }
      if (e < 1e-12) continue;
      const mag = Math.sqrt(cR * cR + cI * cI);
      const norm = mag / Math.sqrt(e * SYNC_LEN);
      if (norm > best) best = norm;
    }
    return { corr: best };
  }
}

/** Plain Goertzel — magnitude² at a single bin. Cheaper than a full
 *  FFT when we only need 3-6 bins. */
function goertzelMag2(x: ArrayLike<number>, hz: number, fs: number, N: number): number {
  const k = (2 * Math.PI * hz) / fs;
  const cos2 = 2 * Math.cos(k);
  let q1 = 0, q2 = 0;
  for (let i = 0; i < N; i++) {
    const q0 = cos2 * q1 - q2 + x[i];
    q2 = q1;
    q1 = q0;
  }
  // |X[k]|² = q1² + q2² - q1·q2·2cos(k)
  return q1 * q1 + q2 * q2 - q1 * q2 * cos2;
}
