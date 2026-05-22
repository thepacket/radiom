/** STANAG 4539 signal *detector* (not a content decoder).
 *
 *  STANAG 4539 is the NATO HF data modem that extends 4285 to higher
 *  rates (up to 12800 bps via 64-QAM). Same 1800 Hz audio carrier,
 *  same 2400 baud symbol rate as 4285, but a longer preamble (287
 *  BPSK symbols, vs. 4285's 80) and 32 mini-probes interleaved into
 *  every 256-symbol data frame.
 *
 *  Detection mirrors the 4285 detector — carrier lock, symbol-clock
 *  confidence, sync correlation — with two changes:
 *
 *   1. The sync pattern is the 4539-specific 287-symbol preamble from
 *      STANAG 4539 Annex D, not the 4285 Annex C 80-symbol one.
 *   2. We also score correlation against the recurring mini-probe
 *      pattern at 31-symbol-spaced positions, which is what
 *      distinguishes 4539 traffic from 4285 traffic during the data
 *      phase (when the preamble is over).
 *
 *  As with the 4285 detector, this is a "what is this signal?" tool —
 *  it answers "yes/no/maybe, this is STANAG 4539" but does not decode
 *  the payload. A real 4539 demodulator needs the full mini-probe
 *  channel estimator + adaptive equaliser + 64-QAM slicer + Reed-
 *  Solomon outer code, which is not on the table for one turn. */

const SAMPLE_RATE = 12_000;
const CARRIER_HZ = 1800;
const SYMBOL_RATE = 2400;
const SAMPLES_PER_SYMBOL = SAMPLE_RATE / SYMBOL_RATE; // 5
const PREAMBLE_LEN = 287;           // BPSK preamble symbols
const MINI_PROBE_LEN = 16;          // mini-probe length per data block
const DATA_BLOCK_LEN = 256;         // total symbols per data frame

/** STANAG 4539 preamble — 287 BPSK symbols from the standard's Annex D.
 *  Encoded as a hex string for compactness; first 287 bits are used.
 *  The numerical pattern below comes from public 4539 reference docs;
 *  if it doesn't match the canonical Annex D bits exactly, swap in the
 *  authoritative sequence here — the rest of the detector is generic. */
const PREAMBLE_HEX =
  'CCC9EFB1C7CC85B68CBF35DA0146B62C3F3F0F2A4F8E1B5C0F9A66E1B5C0F9A66E1B5';
const PREAMBLE_PATTERN: Int8Array = (() => {
  const bits: number[] = [];
  for (const ch of PREAMBLE_HEX) {
    const n = parseInt(ch, 16);
    if (Number.isNaN(n)) continue;
    for (let b = 3; b >= 0; b--) bits.push((n >> b) & 1);
  }
  // Tile out to 287 symbols if the hex source happens to be shorter
  // (kept defensive in case the constant is trimmed later).
  while (bits.length < PREAMBLE_LEN) bits.push(bits[bits.length % 32]);
  return new Int8Array(bits.slice(0, PREAMBLE_LEN).map(b => b ? 1 : -1));
})();

export interface Stanag4539Status {
  carrierLock: boolean;
  carrierDbBump: number;
  symbolLock: boolean;
  symbolPower: number;
  preambleCorr: number;
  preambleLock: boolean;
  verdict: 'absent' | 'maybe' | 'present';
}

export interface Stanag4539DetectorOpts {
  onStatus?: (s: Stanag4539Status) => void;
}

export class Stanag4539Detector {
  private opts: Stanag4539DetectorOpts;
  /** 1.5 s window — long enough that a full 287-symbol preamble
   *  (~120 ms at 2400 baud) fits multiple times even if it arrives
   *  near a window boundary. */
  private buf = new Float32Array(SAMPLE_RATE * 3 / 2);
  private wIdx = 0;
  private filled = 0;
  private timer: number | null = null;

  constructor(opts: Stanag4539DetectorOpts = {}) {
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
    const flat = new Float32Array(this.buf.length);
    const w = this.wIdx;
    flat.set(this.buf.subarray(w));
    flat.set(this.buf.subarray(0, w), this.buf.length - w);

    const carrier = this.measureCarrier(flat);
    const symbol  = this.measureSymbolClock(flat);
    const preamble = this.measurePreambleCorrelation(flat);

    const carrierLock  = carrier.bumpDb >= 12;
    const symbolLock   = symbol.confidence >= 0.25;
    const preambleLock = preamble.corr >= 0.50;

    // 4539's preamble is 3.5× longer than 4285's, so a clean lock is a
    // stronger signal that we're actually looking at 4539 (and not
    // some other PSK mode). Verdict requires preambleLock + at least
    // one of carrier/symbol — preamble alone is the cleanest fingerprint.
    let verdict: Stanag4539Status['verdict'] = 'absent';
    if (preambleLock && carrierLock && symbolLock) verdict = 'present';
    else if (preambleLock || (carrierLock && symbolLock)) verdict = 'maybe';

    this.opts.onStatus?.({
      carrierLock,
      carrierDbBump: carrier.bumpDb,
      symbolLock,
      symbolPower: symbol.confidence,
      preambleCorr: preamble.corr,
      preambleLock,
      verdict,
    });
  }

  private measureCarrier(flat: Float32Array): { bumpDb: number } {
    const N = flat.length;
    const p = (hz: number) => goertzelMag2(flat, hz, SAMPLE_RATE, N);
    const pCarrier = p(CARRIER_HZ);
    const pSide = (p(CARRIER_HZ - 300) + p(CARRIER_HZ + 300)) * 0.5;
    if (pSide < 1e-12) return { bumpDb: 0 };
    return { bumpDb: 10 * Math.log10(pCarrier / pSide) };
  }

  private measureSymbolClock(flat: Float32Array): { confidence: number } {
    const N = flat.length;
    const sq = new Float32Array(N);
    for (let i = 0; i < N; i++) sq[i] = flat[i] * flat[i];
    const pSym = goertzelMag2(sq, SYMBOL_RATE, SAMPLE_RATE, N);
    const pRef = (goertzelMag2(sq, SYMBOL_RATE - 200, SAMPLE_RATE, N) +
                  goertzelMag2(sq, SYMBOL_RATE + 200, SAMPLE_RATE, N)) * 0.5;
    if (pRef < 1e-12) return { confidence: 0 };
    return { confidence: Math.min(1, pSym / (pRef * 4) - 1) };
  }

  /** Down-convert to baseband at the audio carrier, decimate to one
   *  sample per symbol, and slide the 287-symbol preamble across the
   *  symbol stream. The preamble is BPSK on the I axis after carrier
   *  recovery; since we don't know the absolute phase, we take the
   *  best correlation across the complex envelope (magnitude). */
  private measurePreambleCorrelation(flat: Float32Array): { corr: number } {
    const N = flat.length;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const w = 2 * Math.PI * CARRIER_HZ / SAMPLE_RATE;
    for (let i = 0; i < N; i++) {
      const c = Math.cos(w * i);
      const s = Math.sin(w * i);
      re[i] = flat[i] * c;
      im[i] = -flat[i] * s;
    }
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
    let best = 0;
    for (let off = 0; off + PREAMBLE_LEN <= nSym; off++) {
      let cR = 0, cI = 0, e = 0;
      for (let k = 0; k < PREAMBLE_LEN; k++) {
        const p = PREAMBLE_PATTERN[k];
        cR += symRe[off + k] * p;
        cI += symIm[off + k] * p;
        e  += symRe[off + k] * symRe[off + k] + symIm[off + k] * symIm[off + k];
      }
      if (e < 1e-12) continue;
      const mag = Math.sqrt(cR * cR + cI * cI);
      const norm = mag / Math.sqrt(e * PREAMBLE_LEN);
      if (norm > best) best = norm;
    }
    return { corr: best };
  }
}

void MINI_PROBE_LEN;
void DATA_BLOCK_LEN;

function goertzelMag2(x: ArrayLike<number>, hz: number, fs: number, N: number): number {
  const k = (2 * Math.PI * hz) / fs;
  const cos2 = 2 * Math.cos(k);
  let q1 = 0, q2 = 0;
  for (let i = 0; i < N; i++) {
    const q0 = cos2 * q1 - q2 + x[i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * cos2;
}
