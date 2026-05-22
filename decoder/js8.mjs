// JS8Call decoder — Node-side wrapper around the standalone `js8` binary
// from js8call source.
//
// JS8 "Normal" mode uses 15-second TX/RX slots aligned to multiples of
// 15 sec UTC (i.e. seconds {00, 15, 30, 45} of every minute). We:
//
//   1. Buffer 12 kHz int16 PCM samples into a sliding window.
//   2. At each 15-sec UTC boundary, swap to a new buffer.
//   3. After ~14 sec of capture (slightly inside the slot to ensure
//      we get the trailing TX), write a WAV file and spawn `js8`.
//   4. Parse js8 stdout for decoded message lines.
//
// The js8 binary may be missing (binary built only on Linux via Docker
// or on macOS only when gfortran+cmake+fftw are installed). When it's
// missing we still capture & enqueue the WAV but report "decoder
// binary missing" in onStatus.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'js8', 'bin', 'js8');

const JS8_SAMPLE_RATE = 12_000;
const JS8_PERIOD_MS   = 15_000;            // Normal mode: 15-sec slots
const JS8_CAPTURE_MS  = 14_000;            // capture window inside the slot
const JS8_BUFFER_SIZE = JS8_SAMPLE_RATE * (JS8_PERIOD_MS / 1000);

export class Js8Decoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz  Current dial freq for output annotation.
   * @param {(spot: Js8Spot) => void} [opts.onSpot]
   * @param {(msg: string) => void}   [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    /** @type {Int16Array | null} active period buffer */
    this.buf = null;
    this.bufPos = 0;
    this.captureUntilTs = 0;
    this.periodStartTs = 0;
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-js8-'));
    this.closed = false;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('js8 binary missing — run `npm run build:js8`');
    }
    this.scheduleNextPeriod();
  }

  feed(/** @type {Int16Array} */ samples) {
    if (this.closed) return;
    if (!this.buf) return;
    const n = samples.length;
    const room = JS8_BUFFER_SIZE - this.bufPos;
    const take = Math.min(n, room);
    if (take <= 0) return;
    this.buf.set(samples.subarray(0, take), this.bufPos);
    this.bufPos += take;
  }

  close() {
    this.closed = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try { rmSync(this.tmpDir, { recursive: true, force: true }); } catch {}
  }

  /** Reset all timing and start a capture window IMMEDIATELY (skipping
   *  the UTC-multiple-of-15-s alignment). Used by the INJECT test path
   *  so a pre-aligned sample lines up with the capture window. */
  forceStartNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.buf = null;
    this.bufPos = 0;
    this.startPeriod();
  }

  /** Schedule the next JS8 slot at the next multiple of 15 s UTC. */
  scheduleNextPeriod() {
    if (this.closed) return;
    const now = Date.now();
    const msIntoPeriod = now % JS8_PERIOD_MS;
    const msUntilNext = JS8_PERIOD_MS - msIntoPeriod;
    this._timer = setTimeout(() => this.startPeriod(), msUntilNext);
    this.opts.onStatus?.(`waiting for next 15-s slot in ${Math.round(msUntilNext / 1000)} s`);
  }

  /** Start a capture window — called at a 15-s UTC boundary. */
  startPeriod() {
    if (this.closed) return;
    this.buf = new Int16Array(JS8_BUFFER_SIZE);
    this.bufPos = 0;
    this.periodStartTs = Date.now();
    this.captureUntilTs = this.periodStartTs + JS8_CAPTURE_MS;
    this.opts.onStatus?.('capturing 14 s window');
    this._timer = setTimeout(() => this.endPeriod(), JS8_CAPTURE_MS);
  }

  /** Capture window ended → write WAV, spawn js8, parse output. */
  endPeriod() {
    if (this.closed) return;
    const samples = this.buf?.subarray(0, this.bufPos);
    this.buf = null;
    this.bufPos = 0;
    if (samples && samples.length >= JS8_SAMPLE_RATE * 12) {  // ≥12 s usable
      const ts = new Date(this.periodStartTs);
      const wavPath = path.join(this.tmpDir, `js8_${ts.getTime()}.wav`);
      try {
        writeFileSync(wavPath, this.buildWav(samples));
        this.runJs8(wavPath);
      } catch (e) {
        this.opts.onStatus?.(`WAV write failed: ${e.message}`);
      }
    } else {
      this.opts.onStatus?.(`skipped slot (only ${samples?.length ?? 0} samples captured)`);
    }
    this.scheduleNextPeriod();
  }

  /** Build a 12 kHz mono int16 RIFF/WAV blob (same shape wsprd accepts). */
  buildWav(/** @type {Int16Array} */ samples) {
    const byteLen = samples.byteLength;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + byteLen, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);                 // PCM
    header.writeUInt16LE(1, 22);                 // mono
    header.writeUInt32LE(JS8_SAMPLE_RATE, 24);
    header.writeUInt32LE(JS8_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(byteLen, 40);
    return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, byteLen)]);
  }

  runJs8(/** @type {string} */ wavPath) {
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('js8 binary missing — run `npm run build:js8`');
      try { rmSync(wavPath); } catch {}
      return;
    }
    let proc;
    try {
      // js8 -B for "Normal" mode, with the WAV as positional arg.
      proc = spawn(BIN, ['-B', wavPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      try { rmSync(wavPath); } catch {}
      return;
    }
    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => {
      console.error('[js8]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code) => {
      try { rmSync(wavPath); } catch {}
      if (code !== 0) {
        this.opts.onStatus?.(`decoder exited code=${code}`);
        return;
      }
      const dialKHz = this.opts.dialFreqKHz?.() ?? 0;
      const spots = parseJs8Output(stdout, dialKHz);
      this.opts.onStatus?.(`decoded ${spots.length} message${spots.length === 1 ? '' : 's'}`);
      for (const spot of spots) this.opts.onSpot?.(spot);
    });
  }
}

/** js8 stdout format (per decoded line):
 *    HHMMSS  SNR  DT  FreqOffsetHz  Message
 *  (similar to jt9). The exact format depends on the js8call build, so
 *  this parser is permissive: any line with 4+ whitespace-separated
 *  tokens whose first three look like time/snr/dt is accepted as a
 *  decode and the remainder treated as the message. */
export function parseJs8Output(text, dialKHz = 0) {
  /** @type {Js8Spot[]} */
  const spots = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Permissive: HHMMSS SNR DT FreqHz Message...
    const m = line.match(
      /^(\d{4,6})\s+(-?\d+)\s+(-?\d+\.\d+)\s+(-?\d+)\s+(.+)$/
    );
    if (!m) continue;
    spots.push({
      time:    m[1],
      snrDb:   parseInt(m[2], 10),
      dtSec:   parseFloat(m[3]),
      freqHz:  parseInt(m[4], 10),
      freqMHz: dialKHz > 0 ? (dialKHz + parseInt(m[4], 10) / 1000) / 1000 : 0,
      message: m[5].trim(),
    });
  }
  return spots;
}

/** @typedef {object} Js8Spot
 *  @property {string} time     UTC HHMMSS
 *  @property {number} snrDb
 *  @property {number} dtSec
 *  @property {number} freqHz   audio offset
 *  @property {number} freqMHz  absolute (dial + offset) if dial is known
 *  @property {string} message  free-form JS8 message
 */
