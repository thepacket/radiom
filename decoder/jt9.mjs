// JT9 decoder — Node-side wrapper around the standalone `jt9` binary
// from wsjt-x source.
//
// JT9 is the original WSJT-X weak-signal narrowband mode (9-FSK, ~ -27 dB
// SNR threshold). Slots are 60 s long, aligned to the start of each UTC
// minute; the actual TX window is ~49 s with the remainder reserved for
// decode + send. Pipeline:
//
//   1. Buffer 12 kHz int16 PCM samples in memory.
//   2. At each UTC-minute boundary, swap to a new buffer.
//   3. After ~50 s of capture (~end of TX window), write a WAV file and
//      spawn `jt9 -9 <wav>`.
//   4. Parse stdout for decoded message lines.
//
// jt9 may be missing if the Linux Docker stage hasn't built it — runtime
// gracefully reports that.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'jt9', 'bin', 'jt9');

const JT9_SAMPLE_RATE = 12_000;
const JT9_PERIOD_MS   = 60_000;   // 1-minute UTC slots
const JT9_CAPTURE_MS  = 50_000;   // capture window inside the slot
const JT9_BUFFER_SIZE = JT9_SAMPLE_RATE * (JT9_PERIOD_MS / 1000);

export class Jt9Decoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz  Current dial freq (kHz) for output annotation.
   * @param {(spot: Jt9Spot) => void} [opts.onSpot]
   * @param {(msg: string) => void}   [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    /** @type {Int16Array | null} */
    this.buf = null;
    this.bufPos = 0;
    this.captureUntilTs = 0;
    this.periodStartTs = 0;
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-jt9-'));
    this.closed = false;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('jt9 binary missing — run `npm run build:jt9`');
    }
    this.scheduleNextPeriod();
  }

  feed(/** @type {Int16Array} */ samples) {
    if (this.closed || !this.buf) return;
    const room = JT9_BUFFER_SIZE - this.bufPos;
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

  /** Reset all timing and start a capture window IMMEDIATELY (skipping
   *  UTC alignment). Used by the INJECT test path so a pre-aligned WAV
   *  lines up with the capture window. */
  forceStartNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.buf = null;
    this.bufPos = 0;
    this.startPeriod();
  }

  scheduleNextPeriod() {
    if (this.closed) return;
    const now = Date.now();
    const msIntoPeriod = now % JT9_PERIOD_MS;
    const msUntilNext = JT9_PERIOD_MS - msIntoPeriod;
    this._timer = setTimeout(() => this.startPeriod(), msUntilNext);
    this.opts.onStatus?.(`waiting for next 1-min boundary in ${Math.round(msUntilNext / 1000)} s`);
  }

  startPeriod() {
    if (this.closed) return;
    this.buf = new Int16Array(JT9_BUFFER_SIZE);
    this.bufPos = 0;
    this.periodStartTs = Date.now();
    this.captureUntilTs = this.periodStartTs + JT9_CAPTURE_MS;
    this.opts.onStatus?.('capturing 50 s window');
    this._timer = setTimeout(() => this.endPeriod(), JT9_CAPTURE_MS);
  }

  endPeriod() {
    if (this.closed) return;
    const samples = this.buf?.subarray(0, this.bufPos);
    this.buf = null;
    this.bufPos = 0;
    // Require at least 40 s captured — below that jt9's sync hunt fails.
    if (samples && samples.length >= JT9_SAMPLE_RATE * 40) {
      const ts = new Date(this.periodStartTs);
      const wavPath = path.join(this.tmpDir, `jt9_${ts.getTime()}.wav`);
      try {
        writeFileSync(wavPath, this.buildWav(samples));
        this.runJt9(wavPath);
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
    header.writeUInt32LE(JT9_SAMPLE_RATE, 24);
    header.writeUInt32LE(JT9_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(byteLen, 40);
    return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, byteLen)]);
  }

  runJt9(/** @type {string} */ wavPath) {
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('jt9 binary missing — run `npm run build:jt9`');
      try { rmSync(wavPath); } catch {}
      return;
    }
    // `-9` selects JT9 mode (the binary can also decode JT65 / JT4 with
    // other flags, but we keep this client mode-specific).
    let proc;
    try {
      proc = spawn(BIN, ['-9', wavPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      try { rmSync(wavPath); } catch {}
      return;
    }
    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => {
      console.error('[jt9]', chunk.toString().trimEnd());
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

/** jt9 stdout format (per spot line):
 *    HHMM  SNR  DT   Freq   Sync   Message
 *  e.g.
 *    1234  -15   0.3   1500   ~     CQ N0CALL EM48
 *  Lines that aren't decode rows are filtered out by the regex. */
export function parseJt9Output(text) {
  /** @type {Jt9Spot[]} */
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

/** @typedef {object} Jt9Spot
 *  @property {string} time     UTC HHMM
 *  @property {number} snrDb
 *  @property {number} dtSec
 *  @property {number} freqHz   audio offset within the slot
 *  @property {string} message  raw decoded message
 */
