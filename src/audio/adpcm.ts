/** IMA ADPCM decoder (Intel/DVI form), as used by KiwiSDR when
 *  `SET compression=1` is enabled. Each input byte holds two 4-bit nibbles
 *  representing differential predictor steps; we expand them back to int16.
 *  Decoder state (predictor + step index) is kept across frames so the
 *  reconstruction stays continuous. */

const STEP_TABLE = new Int16Array([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
  724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
  3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]);

const INDEX_TABLE = new Int8Array([
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
]);

export class AdpcmDecoder {
  private predictor = 0;
  private stepIdx = 0;

  reset(): void {
    this.predictor = 0;
    this.stepIdx = 0;
  }

  /** Re-anchor predictor + step index. Used by OpenWebRX, which re-syncs
   *  the decoder every ~1000 samples via inline "SYNC" markers. */
  setState(stepIdx: number, predictor: number): void {
    this.stepIdx = Math.max(0, Math.min(88, stepIdx | 0));
    this.predictor = Math.max(-32768, Math.min(32767, predictor | 0));
  }

  /** Decode `bytes.length * 2` samples of int16 PCM into `out` (must be sized
   *  for that count). Returns the number of samples written. */
  decodeInto(bytes: Uint8Array, out: Int16Array): number {
    let n = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      out[n++] = this.decodeNibble(b & 0x0f);
      out[n++] = this.decodeNibble((b >> 4) & 0x0f);
    }
    return n;
  }

  /** Decode a single 4-bit nibble. Exposed for callers like OpenWebRX
   *  that decode byte-by-byte while watching for inline sync markers. */
  decodeNibble(nibble: number): number {
    const step = STEP_TABLE[this.stepIdx];
    let diff = step >> 3;
    if (nibble & 4) diff += step;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 1) diff += step >> 2;
    if (nibble & 8) diff = -diff;
    let p = this.predictor + diff;
    if (p > 32767) p = 32767; else if (p < -32768) p = -32768;
    this.predictor = p;
    let s = this.stepIdx + INDEX_TABLE[nibble];
    if (s < 0) s = 0; else if (s > 88) s = 88;
    this.stepIdx = s;
    return p;
  }
}
