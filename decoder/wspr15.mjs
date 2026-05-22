// WSPR-15 (Weak Signal Propagation Reporter, 15-minute variant) — Node-side wrapper.
//
// WSPR-15 transmits over ~14 min on a 15-minute UTC-aligned period
// (start at :00, :15, :30, :45). Same modulation as ordinary 2-minute
// WSPR but with a 16× lower symbol rate, gaining ~12 dB of sensitivity
// for LF/MF DX work. Identical pipeline to wspr.mjs, just with longer
// timing constants and `-m` passed to wsprd so the binary parses the
// WAV as a 15-minute capture.
//
// Note: WSPR-15 was largely superseded by FST4W (already shipped here)
// but a small population of LF/MF beacons still transmit it; ARRL's
// observations on 137 kHz and 475 kHz often need WSPR-15 to read.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseWsprdOutput } from './wspr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'wspr', 'bin', 'wsprd');

const WSPR15_SAMPLE_RATE = 12_000;
const WSPR15_PERIOD_MS   = 15 * 60 * 1000;   // 15 minutes
const WSPR15_CAPTURE_MS  = 14 * 60 * 1000;   // capture inside the period
const WSPR15_BUFFER_SIZE = WSPR15_SAMPLE_RATE * (WSPR15_PERIOD_MS / 1000);

export class Wspr15Decoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz  Current dial freq for output annotation.
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
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-wspr15-'));
    this.closed = false;
    this.scheduleNextPeriod();
  }

  feed(/** @type {Int16Array} */ samples) {
    if (this.closed || !this.buf) return;
    const n = samples.length;
    const room = WSPR15_BUFFER_SIZE - this.bufPos;
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
   *  the UTC 15-minute alignment). Used by the INJECT test path so a
   *  pre-aligned WAV sample lines up with the capture window. */
  forceStartNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.buf = null;
    this.bufPos = 0;
    this.startPeriod();
  }

  scheduleNextPeriod() {
    if (this.closed) return;
    const now = Date.now();
    const msIntoPeriod = now % WSPR15_PERIOD_MS;
    const msUntilNext = WSPR15_PERIOD_MS - msIntoPeriod;
    this._timer = setTimeout(() => this.startPeriod(), msUntilNext);
    const mins = Math.round(msUntilNext / 60_000);
    this.opts.onStatus?.(`waiting for next :00/:15/:30/:45 boundary in ~${mins} min`);
  }

  startPeriod() {
    if (this.closed) return;
    this.buf = new Int16Array(WSPR15_BUFFER_SIZE);
    this.bufPos = 0;
    this.periodStartTs = Date.now();
    this.captureUntilTs = this.periodStartTs + WSPR15_CAPTURE_MS;
    this.opts.onStatus?.('capturing 14-min window');
    this._timer = setTimeout(() => this.endPeriod(), WSPR15_CAPTURE_MS);
  }

  endPeriod() {
    if (this.closed) return;
    const samples = this.buf?.subarray(0, this.bufPos);
    this.buf = null;
    this.bufPos = 0;
    // ≥ 12 minutes usable; below that, wsprd's sync hunt mostly fails.
    if (samples && samples.length >= WSPR15_SAMPLE_RATE * 720) {
      const ts = new Date(this.periodStartTs);
      const wavPath = path.join(this.tmpDir, `wspr15_${ts.getTime()}.wav`);
      try {
        writeFileSync(wavPath, this.buildWav(samples));
        this.runWsprd(wavPath);
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
    header.writeUInt32LE(WSPR15_SAMPLE_RATE, 24);
    header.writeUInt32LE(WSPR15_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(byteLen, 40);
    return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, byteLen)]);
  }

  runWsprd(/** @type {string} */ wavPath) {
    const dialMHz = (this.opts.dialFreqKHz?.() ?? 0.1374) / 1000;
    let proc;
    try {
      // -m → wsprd parses the WAV as a 15-minute capture (vs 2-minute default).
      proc = spawn(BIN, ['-m', '-f', dialMHz.toFixed(6), '-d', wavPath], {
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
      console.error('[wsprd-15]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code) => {
      try { rmSync(wavPath); } catch {}
      if (code !== 0) {
        this.opts.onStatus?.(`decoder exited code=${code}`);
        return;
      }
      const spots = parseWsprdOutput(stdout);
      this.opts.onStatus?.(`decoded ${spots.length} spot${spots.length === 1 ? '' : 's'}`);
      for (const spot of spots) this.opts.onSpot?.(spot);
    });
  }
}
