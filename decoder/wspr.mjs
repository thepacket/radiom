// WSPR (Weak Signal Propagation Reporter) decoder — Node-side wrapper.
//
// WSPR is a 2-minute-period mode. Transmissions start at UTC :00 of each
// even minute, last ~110.6 s, and decoders run on the captured 120 s
// window. Unlike streaming decoders, this is batch:
//
//   1. Buffer 12 kHz int16 PCM samples in memory.
//   2. At each even-UTC-minute boundary, swap to a new buffer.
//   3. After 116 seconds of capture (~end of TX window), write a WAV
//      file and spawn `wsprd <file>`.
//   4. Parse wsprd's stdout for spot lines and emit them.
//
// The captured buffer is a JS Buffer (raw int16 little-endian PCM).
// We prepend a fresh WAV header before spawning wsprd.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'wspr', 'bin', 'wsprd');

const WSPR_SAMPLE_RATE = 12_000;
const WSPR_PERIOD_MS   = 120_000;          // 2 minutes
const WSPR_CAPTURE_MS  = 116_000;          // capture window inside the period
const WSPR_BUFFER_SIZE = WSPR_SAMPLE_RATE * (WSPR_PERIOD_MS / 1000);  // samples

export class WsprDecoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz  Current dial freq for output annotation.
   * @param {(spot: WsprSpot) => void} [opts.onSpot]
   * @param {(msg: string) => void}   [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    /** @type {Int16Array | null} active period buffer (allocated lazily on minute boundary) */
    this.buf = null;
    this.bufPos = 0;        // samples written into this.buf
    this.captureUntilTs = 0; // wall-clock ms when capture should stop
    this.periodStartTs = 0;
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-wspr-'));
    this.closed = false;
    this.scheduleNextPeriod();
  }

  feed(/** @type {Int16Array} */ samples) {
    if (this.closed) return;
    if (!this.buf) return; // outside an active capture window
    const n = samples.length;
    const room = WSPR_BUFFER_SIZE - this.bufPos;
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
   *  the UTC even-minute alignment). Used by the INJECT test path so a
   *  pre-aligned WAV sample lines up with the capture window. */
  forceStartNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.buf = null;
    this.bufPos = 0;
    this.startPeriod();
  }

  /** Schedule the next period start at the next even UTC minute boundary. */
  scheduleNextPeriod() {
    if (this.closed) return;
    const now = Date.now();
    const minuteMs = 60_000;
    const periodMs = 2 * minuteMs;
    // Align to UTC even minute (i.e. the minute floor of `now` whose
    // UTC minute is even).
    const msIntoPeriod = now % periodMs;
    const msUntilNext = periodMs - msIntoPeriod;
    this._timer = setTimeout(() => this.startPeriod(), msUntilNext);
    this.opts.onStatus?.(`waiting for next 2-min boundary in ${Math.round(msUntilNext / 1000)} s`);
  }

  /** Start a new capture window — called exactly at a UTC even minute. */
  startPeriod() {
    if (this.closed) return;
    this.buf = new Int16Array(WSPR_BUFFER_SIZE);
    this.bufPos = 0;
    this.periodStartTs = Date.now();
    this.captureUntilTs = this.periodStartTs + WSPR_CAPTURE_MS;
    this.opts.onStatus?.('capturing 116 s window');
    // Schedule end-of-capture → decode.
    this._timer = setTimeout(() => this.endPeriod(), WSPR_CAPTURE_MS);
  }

  /** Capture window ended → write WAV, spawn wsprd, parse output. Then
   *  schedule the next period. */
  endPeriod() {
    if (this.closed) return;
    const samples = this.buf?.subarray(0, this.bufPos);
    this.buf = null;
    this.bufPos = 0;
    if (samples && samples.length >= WSPR_SAMPLE_RATE * 100) {  // ≥100 s usable
      const ts = new Date(this.periodStartTs);
      const wavPath = path.join(this.tmpDir, `wspr_${ts.getTime()}.wav`);
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

  /** Build a 12 kHz mono int16 RIFF/WAV blob. */
  buildWav(/** @type {Int16Array} */ samples) {
    const byteLen = samples.byteLength;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + byteLen, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);                // fmt chunk size
    header.writeUInt16LE(1, 20);                 // PCM
    header.writeUInt16LE(1, 22);                 // mono
    header.writeUInt32LE(WSPR_SAMPLE_RATE, 24);
    header.writeUInt32LE(WSPR_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);                 // block align
    header.writeUInt16LE(16, 34);                // bits/sample
    header.write('data', 36);
    header.writeUInt32LE(byteLen, 40);
    return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, byteLen)]);
  }

  runWsprd(/** @type {string} */ wavPath) {
    const dialMHz = (this.opts.dialFreqKHz?.() ?? 14_097.1) / 1000;
    let proc;
    try {
      proc = spawn(BIN, ['-f', dialMHz.toFixed(6), '-d', wavPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      try { rmSync(wavPath); } catch {}
      return;
    }
    // ENOENT and other spawn-time errors arrive as an 'error' event
    // on the ChildProcess, not as a synchronous throw. Without this
    // handler the unhandled 'error' crashes the whole node server.
    proc.on('error', (e) => {
      console.error('[wsprd] spawn error:', e.message);
      this.opts.onStatus?.(`wsprd unavailable: ${e.message}`);
      try { rmSync(wavPath); } catch {}
    });
    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => {
      console.error('[wsprd]', chunk.toString().trimEnd());
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

/** wsprd stdout format (per line):
 *    HHMM  SNR  dt  freq  drift  message
 *  e.g.
 *    0010 -25  0.5  14.097100 -1  N0CALL EM48 30
 *  Lines that aren't decode rows (banners, "<DecodeFinished>", etc.) are
 *  filtered out by the regex below. */
export function parseWsprdOutput(text) {
  /** @type {WsprSpot[]} */
  const spots = [];
  for (const line of text.split('\n')) {
    const m = line.match(
      /^\s*(\d{4})\s+(-?\d+)\s+(-?\d+\.\d+)\s+(\d+\.\d+)\s+(-?\d+)\s+(.+?)\s*$/
    );
    if (!m) continue;
    spots.push({
      time:  m[1],
      snrDb: parseInt(m[2], 10),
      dtSec: parseFloat(m[3]),
      freqMHz: parseFloat(m[4]),
      driftHz: parseInt(m[5], 10),
      message: m[6].trim(),
    });
  }
  return spots;
}

/** @typedef {object} WsprSpot
 *  @property {string} time     UTC HHMM of decode period start
 *  @property {number} snrDb
 *  @property {number} dtSec
 *  @property {number} freqMHz
 *  @property {number} driftHz
 *  @property {string} message  e.g. "N0CALL EM48 30"
 */
