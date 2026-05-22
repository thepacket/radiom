// FST4W (Beacon) decoder — Node-side wrapper around the standalone
// `fst4d` binary from wsjt-x source, run with the `-W` flag so it
// decodes the beacon protocol (FST4W) rather than the QSO protocol
// (FST4). Same binary, same WAV format, different bit-level frame.
//
// FST4W is the modern WSPR replacement: same beacon use-case (CALL +
// GRID + dBm), same 200 Hz sub-bands, but with configurable periods
// (60/120/300/900/1800 s) and noticeably better sensitivity than
// WSPR-2 at the longer periods. Most active 20 m channel: 14095.6 kHz
// dial (= 14097.1 kHz audio centre — same as WSPR for backward compat).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFst4Output } from './fst4.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'fst4', 'bin', 'fst4d');

const FST4W_SAMPLE_RATE = 12_000;
const VALID_PERIODS = new Set([60, 120, 300, 900, 1800]);

export class Fst4wDecoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz
   * @param {number} [opts.periodSec=120]   FST4W submode period; default 120 (2-min, matches WSPR).
   * @param {(spot: object) => void} [opts.onSpot]
   * @param {(msg: string) => void}  [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.periodSec = VALID_PERIODS.has(opts.periodSec) ? opts.periodSec : 120;
    this.bufferSize = FST4W_SAMPLE_RATE * this.periodSec;
    /** @type {Int16Array | null} */
    this.buf = null;
    this.bufPos = 0;
    this.captureUntilTs = 0;
    this.periodStartTs = 0;
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-fst4w-'));
    this.closed = false;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('fst4d binary missing — run `npm run build:fst4`');
    }
    this.scheduleNextPeriod();
  }

  feed(/** @type {Int16Array} */ samples) {
    if (this.closed || !this.buf) return;
    const room = this.bufferSize - this.bufPos;
    const take = Math.min(samples.length, room);
    if (take <= 0) return;
    this.buf.set(samples.subarray(0, take), this.bufPos);
    this.bufPos += take;
  }

  close() {
    this.closed = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try { rmSync(this.tmpDir, { recursive: true, force: true }); } catch {}
  }

  forceStartNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.buf = null;
    this.bufPos = 0;
    this.startPeriod();
  }

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
    const minSamples = Math.floor(FST4W_SAMPLE_RATE * this.periodSec * 0.8);
    if (samples && samples.length >= minSamples) {
      const ts = new Date(this.periodStartTs);
      const wavPath = path.join(this.tmpDir, `fst4w_${ts.getTime()}.wav`);
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
    header.writeUInt32LE(FST4W_SAMPLE_RATE, 24);
    header.writeUInt32LE(FST4W_SAMPLE_RATE * 2, 28);
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
      // `-W` selects FST4W (beacon) mode in fst4d. Without it the binary
      // tries to decode QSO frames — what the existing `fst4.mjs` does.
      proc = spawn(BIN, [
        '-W',
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
      console.error('[fst4w]', chunk.toString().trimEnd());
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
