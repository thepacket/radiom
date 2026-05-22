// FST4 / FST4W decoder — Node-side wrapper around the standalone
// `fst4d` binary from wsjt-x source.
//
// FST4W (the beacon submode, similar to WSPR) runs on configurable
// periods: 60, 120, 300, 900, 1800 sec. We default to FST4W-120
// (2-min slots, same as WSPR) which is the most active submode and
// gives the simplest UTC alignment.
//
//   1. Buffer 12 kHz int16 PCM samples in memory.
//   2. At each period boundary, swap to a new buffer.
//   3. After the period elapses, write a WAV file and spawn `fst4d`.
//   4. Parse stdout for decoded message lines.
//
// fst4d may be missing if the Linux Docker stage hasn't built it —
// runtime gracefully reports that.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'fst4', 'bin', 'fst4d');

const FST4_SAMPLE_RATE = 12_000;

/** Submode periods supported by FST4W. */
const VALID_PERIODS = new Set([60, 120, 300, 900, 1800]);

export class Fst4Decoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz Current dial freq (kHz) for output annotation.
   * @param {number} [opts.periodSec=120]   FST4W submode period; default 120 (2-min).
   * @param {(spot: Fst4Spot) => void} [opts.onSpot]
   * @param {(msg: string) => void}    [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.periodSec = VALID_PERIODS.has(opts.periodSec) ? opts.periodSec : 120;
    this.bufferSize = FST4_SAMPLE_RATE * this.periodSec;
    /** @type {Int16Array | null} */
    this.buf = null;
    this.bufPos = 0;
    this.captureUntilTs = 0;
    this.periodStartTs = 0;
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-fst4-'));
    this.closed = false;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('fst4d binary missing — run `npm run build:fst4`');
    }
    this.scheduleNextPeriod();
  }

  feed(/** @type {Int16Array} */ samples) {
    if (this.closed) return;
    if (!this.buf) return;
    const n = samples.length;
    const room = this.bufferSize - this.bufPos;
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
   *  UTC alignment). Used by the INJECT test path so a pre-aligned WAV
   *  lines up with the capture window. */
  forceStartNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.buf = null;
    this.bufPos = 0;
    this.startPeriod();
  }

  /** Schedule the next period start at the next UTC period boundary. */
  scheduleNextPeriod() {
    if (this.closed) return;
    const now = Date.now();
    const periodMs = this.periodSec * 1000;
    const msIntoPeriod = now % periodMs;
    const msUntilNext = periodMs - msIntoPeriod;
    this._timer = setTimeout(() => this.startPeriod(), msUntilNext);
    this.opts.onStatus?.(
      `waiting for next ${this.periodSec}-s boundary in ${Math.round(msUntilNext / 1000)} s`
    );
  }

  startPeriod() {
    if (this.closed) return;
    this.buf = new Int16Array(this.bufferSize);
    this.bufPos = 0;
    this.periodStartTs = Date.now();
    // Capture for slightly less than the full period to leave time for
    // the file write + decoder spawn within the slot.
    const captureMs = (this.periodSec - 2) * 1000;
    this.captureUntilTs = this.periodStartTs + captureMs;
    this.opts.onStatus?.(`capturing ${this.periodSec - 2} s window`);
    this._timer = setTimeout(() => this.endPeriod(), captureMs);
  }

  endPeriod() {
    if (this.closed) return;
    const samples = this.buf?.subarray(0, this.bufPos);
    this.buf = null;
    this.bufPos = 0;
    // Require at least 80% of the period to have been captured.
    const minSamples = Math.floor(FST4_SAMPLE_RATE * this.periodSec * 0.8);
    if (samples && samples.length >= minSamples) {
      const ts = new Date(this.periodStartTs);
      const wavPath = path.join(this.tmpDir, `fst4_${ts.getTime()}.wav`);
      try {
        writeFileSync(wavPath, this.buildWav(samples));
        this.runFst4d(wavPath);
      } catch (e) {
        this.opts.onStatus?.(`WAV write failed: ${e.message}`);
      }
    } else {
      this.opts.onStatus?.(`skipped period (only ${samples?.length ?? 0} samples captured)`);
    }
    this.scheduleNextPeriod();
  }

  buildWav(/** @type {Int16Array} */ samples) {
    const byteLen = samples.byteLength;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + byteLen, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(FST4_SAMPLE_RATE, 24);
    header.writeUInt32LE(FST4_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(byteLen, 40);
    return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, byteLen)]);
  }

  runFst4d(/** @type {string} */ wavPath) {
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('fst4d binary missing — run `npm run build:fst4`');
      try { rmSync(wavPath); } catch {}
      return;
    }
    const dialMHz = (this.opts.dialFreqKHz?.() ?? 14_095.6) / 1000;
    let proc;
    try {
      // fst4d -p <period> -f <dialMHz> -d <wav>
      proc = spawn(BIN, [
        '-p', String(this.periodSec),
        '-f', dialMHz.toFixed(6),
        '-d', wavPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      try { rmSync(wavPath); } catch {}
      return;
    }
    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => {
      console.error('[fst4d]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code) => {
      try { rmSync(wavPath); } catch {}
      if (code !== 0) {
        this.opts.onStatus?.(`decoder exited code=${code}`);
        return;
      }
      const spots = parseFst4Output(stdout);
      this.opts.onStatus?.(`decoded ${spots.length} spot${spots.length === 1 ? '' : 's'}`);
      for (const spot of spots) this.opts.onSpot?.(spot);
    });
  }
}

/** fst4d stdout format (per spot line):
 *    HHMM  SNR  DT   FreqHz  Sync   Message
 *  e.g.
 *    0010  -25  0.5   1500   0      N0CALL EM48 30
 *  Lines that aren't decode rows (banners, "<DecodeFinished>", etc.)
 *  are filtered by the regex. */
export function parseFst4Output(text) {
  /** @type {Fst4Spot[]} */
  const spots = [];
  for (const line of text.split('\n')) {
    const m = line.match(
      /^\s*(\d{4,6})\s+(-?\d+)\s+(-?\d+\.\d+)\s+(\d+)\s+\S+\s+(.+?)\s*$/
    );
    if (!m) continue;
    spots.push({
      time:   m[1],
      snrDb:  parseInt(m[2], 10),
      dtSec:  parseFloat(m[3]),
      freqHz: parseInt(m[4], 10),
      message: m[5].trim(),
    });
  }
  return spots;
}

/** @typedef {object} Fst4Spot
 *  @property {string} time     UTC HHMM (or HHMMSS in some formats)
 *  @property {number} snrDb
 *  @property {number} dtSec
 *  @property {number} freqHz   audio offset
 *  @property {string} message  raw decoded message
 */
