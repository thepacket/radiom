// JT4 decoder — Node-side wrapper around the standalone `jt9` binary
// from wsjt-x source.
//
// JT4 is the original WSJT EME / weak-tropo mode: 4-FSK with optional
// tone spacings (A=4.4 Hz / B=8.8 / C=17.6 / D=39.7 / E=79.4 / F=158.7
// / G=317.4 Hz, where A is narrowest / most sensitive). Slots are
// 60 s long, aligned to the start of each UTC minute. The same `jt9`
// binary decodes all of them via the `-4` flag.
//
// Pipeline matches JT9 / JT65: buffer 60 s of 12 kHz PCM, write a WAV
// at end-of-slot, spawn jt9. Stdout parsing reuses parseJt9Output.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseJt9Output } from './jt9.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'jt9', 'bin', 'jt9');

const JT4_SAMPLE_RATE = 12_000;
const JT4_PERIOD_MS   = 60_000;
const JT4_CAPTURE_MS  = 50_000;
const JT4_BUFFER_SIZE = JT4_SAMPLE_RATE * (JT4_PERIOD_MS / 1000);

export class Jt4Decoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz
   * @param {(spot: object) => void} [opts.onSpot]
   * @param {(msg: string) => void}  [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    /** @type {Int16Array | null} */
    this.buf = null;
    this.bufPos = 0;
    this.captureUntilTs = 0;
    this.periodStartTs = 0;
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-jt4-'));
    this.closed = false;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('jt9 binary missing — run `npm run build:jt9`');
    }
    this.scheduleNextPeriod();
  }

  feed(/** @type {Int16Array} */ samples) {
    if (this.closed || !this.buf) return;
    const room = JT4_BUFFER_SIZE - this.bufPos;
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
    const msIntoPeriod = now % JT4_PERIOD_MS;
    const msUntilNext = JT4_PERIOD_MS - msIntoPeriod;
    this._timer = setTimeout(() => this.startPeriod(), msUntilNext);
    this.opts.onStatus?.(`waiting for next 1-min boundary in ${Math.round(msUntilNext / 1000)} s`);
  }

  startPeriod() {
    if (this.closed) return;
    this.buf = new Int16Array(JT4_BUFFER_SIZE);
    this.bufPos = 0;
    this.periodStartTs = Date.now();
    this.captureUntilTs = this.periodStartTs + JT4_CAPTURE_MS;
    this.opts.onStatus?.('capturing 50 s window');
    this._timer = setTimeout(() => this.endPeriod(), JT4_CAPTURE_MS);
  }

  endPeriod() {
    if (this.closed) return;
    const samples = this.buf?.subarray(0, this.bufPos);
    this.buf = null;
    this.bufPos = 0;
    if (samples && samples.length >= JT4_SAMPLE_RATE * 40) {
      const ts = new Date(this.periodStartTs);
      const wavPath = path.join(this.tmpDir, `jt4_${ts.getTime()}.wav`);
      try {
        writeFileSync(wavPath, this.buildWav(samples));
        this.runJt4(wavPath);
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
    header.writeUInt32LE(JT4_SAMPLE_RATE, 24);
    header.writeUInt32LE(JT4_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(byteLen, 40);
    return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, byteLen)]);
  }

  runJt4(/** @type {string} */ wavPath) {
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('jt9 binary missing — run `npm run build:jt9`');
      try { rmSync(wavPath); } catch {}
      return;
    }
    let proc;
    try {
      // `-4` selects JT4 mode in the same wsjt-x jt9 binary that
      // handles JT9 / JT65 / Q65.
      proc = spawn(BIN, ['-4', wavPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      try { rmSync(wavPath); } catch {}
      return;
    }
    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => {
      console.error('[jt4]', chunk.toString().trimEnd());
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
