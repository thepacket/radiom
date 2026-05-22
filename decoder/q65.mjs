// Q65 decoder — Node-side wrapper around the standalone `jt9` binary
// from wsjt-x source.
//
// Q65 is the modern WSJT-X weak-signal mode (added 2021, WSJT-X 2.5+).
// Successor to JT65 with 65-FSK + Reed-Solomon, optional 15/30/60/
// 120/300 s slot durations and submodes A..E with different tone
// spacings. The same `jt9` binary decodes it via `-q -p <T_sec>`.
//
// HF practice has settled on Q65-60A — 60-second slots, narrowest tone
// spacing — so that's our default. UTC-aligned on the minute, identical
// timing to JT9 / JT65.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseJt9Output } from './jt9.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'jt9', 'bin', 'jt9');

const Q65_SAMPLE_RATE = 12_000;

/** Slot durations supported by Q65. We default to 60 (Q65-60), the
 *  common HF submode. */
const VALID_PERIODS = new Set([15, 30, 60, 120, 300]);

export class Q65Decoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz
   * @param {number} [opts.periodSec=60]  Q65 slot duration in seconds.
   * @param {(spot: object) => void} [opts.onSpot]
   * @param {(msg: string) => void}  [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.periodSec = VALID_PERIODS.has(opts.periodSec) ? opts.periodSec : 60;
    this.bufferSize = Q65_SAMPLE_RATE * this.periodSec;
    /** @type {Int16Array | null} */
    this.buf = null;
    this.bufPos = 0;
    this.captureUntilTs = 0;
    this.periodStartTs = 0;
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-q65-'));
    this.closed = false;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('jt9 binary missing — run `npm run build:jt9`');
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
    // Reserve ~2 s for file write + decode at the end of each slot.
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
    const minSamples = Math.floor(Q65_SAMPLE_RATE * this.periodSec * 0.7);
    if (samples && samples.length >= minSamples) {
      const ts = new Date(this.periodStartTs);
      const wavPath = path.join(this.tmpDir, `q65_${ts.getTime()}.wav`);
      try {
        writeFileSync(wavPath, this.buildWav(samples));
        this.runQ65(wavPath);
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
    header.writeUInt32LE(Q65_SAMPLE_RATE, 24);
    header.writeUInt32LE(Q65_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(byteLen, 40);
    return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, byteLen)]);
  }

  runQ65(/** @type {string} */ wavPath) {
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('jt9 binary missing — run `npm run build:jt9`');
      try { rmSync(wavPath); } catch {}
      return;
    }
    let proc;
    try {
      // `-q` selects Q65 mode in the wsjt-x jt9 binary; `-p` sets the
      // slot duration so the decoder knows which submode timing to use.
      proc = spawn(BIN, ['-q', '-p', String(this.periodSec), wavPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      try { rmSync(wavPath); } catch {}
      return;
    }
    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => {
      console.error('[q65]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code) => {
      try { rmSync(wavPath); } catch {}
      if (code !== 0) {
        this.opts.onStatus?.(`decoder exited code=${code}`);
        return;
      }
      const spots = parseJt9Output(stdout);
      this.opts.onStatus?.(`decoded ${spots.length} spot${spots.length === 1 ? '' : 's'}`);
      for (const spot of spots) this.opts.onSpot?.(spot);
    });
  }
}
