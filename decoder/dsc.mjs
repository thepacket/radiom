// DSC (Digital Selective Calling) decoder — wraps jbirby/DSC-Codec
// (a Python decoder for ITU-R M.493). Covers VHF Ch 70 (156.525 MHz)
// and the six HF guard channels (2187.5 / 4207.5 / 6312 / 8414.5 /
// 12577 / 16804.5 kHz).
//
// Plumbing notes:
//
// The decoder operates on WAV files, not a streaming pipe. We
// maintain a rolling N-second buffer of 12 kHz int16 mono audio (the
// rate radiom feeds every audio-in decoder at), and on a periodic
// timer write the current window to a tmpfs WAV, invoke the Python
// decoder, and parse stdout. DSC bursts are short (1–7 s typical),
// 100 baud FSK, so the window has to be ≥ ~7 s to catch a full call,
// and the timer should fire faster than that so we always catch the
// burst inside one window even when it straddles two cycles.
//
// Chosen: 10 s rolling buffer, decode every 4 s. Each invocation
// reads only the most recent 10 s of audio — no batch backlog.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.resolve(__dirname, '..', 'decoders', 'dsc', 'bin');
const DECODER = path.join(SCRIPT_DIR, 'dsc_decode.py');

const SAMPLE_RATE   = 12_000;        // wire rate from radiom audio chain
const WINDOW_SEC    = 10;            // rolling buffer length
const DECODE_EVERY  = 4_000;         // ms — overlap so no burst escapes
const WINDOW_BYTES  = SAMPLE_RATE * WINDOW_SEC * 2;   // 12k * 10 * 2 = 240 KB

/** Build a 44-byte PCM WAV header for `dataLen` bytes of int16 mono
 *  at SAMPLE_RATE. Used per decode cycle so the Python decoder can
 *  read a self-contained file. */
function wavHeader(dataLen) {
  const byteRate = SAMPLE_RATE * 2;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);           // PCM
  b.writeUInt16LE(1, 22);           // mono
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(2, 32);           // block align
  b.writeUInt16LE(16, 34);          // bits/sample
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

export class DscDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.closed = false;
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-dsc-'));
    // Ring buffer of recent int16 samples (interleaved == mono).
    this.ring = Buffer.alloc(WINDOW_BYTES);
    this.ringWritePos = 0;
    this.ringFull = false;
    this.lastEmittedHash = '';     // de-dup adjacent identical decodes
    if (!existsSync(DECODER)) {
      this.opts.onStatus?.('DSC decoder missing — run `npm run build:dsc`');
      return;
    }
    // Quick check that python3 is on PATH; otherwise bail fast.
    const probe = spawnSync('python3', ['-c', 'import numpy'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      this.opts.onStatus?.('python3 / numpy missing in runtime');
      return;
    }
    this.opts.onStatus?.('listening (DSC)');
    this.timer = setInterval(() => this.maybeDecode(), DECODE_EVERY);
  }

  /** Append `samples` (Int16Array, 12 kHz mono) to the ring buffer. */
  feed(samples) {
    if (this.closed) return;
    const n = samples.length;
    if (n === 0) return;
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, n * 2);
    let off = 0;
    while (off < bytes.length) {
      const space = WINDOW_BYTES - this.ringWritePos;
      const chunk = Math.min(space, bytes.length - off);
      bytes.copy(this.ring, this.ringWritePos, off, off + chunk);
      this.ringWritePos += chunk;
      off += chunk;
      if (this.ringWritePos >= WINDOW_BYTES) {
        this.ringWritePos = 0;
        this.ringFull = true;
      }
    }
  }

  /** Snapshot the ring buffer into linear order and write a WAV. */
  snapshotWav() {
    const out = Buffer.alloc(WINDOW_BYTES);
    if (this.ringFull) {
      // Older half = ring[writePos..end], newer half = ring[0..writePos]
      const tail = WINDOW_BYTES - this.ringWritePos;
      this.ring.copy(out, 0, this.ringWritePos, WINDOW_BYTES);
      this.ring.copy(out, tail, 0, this.ringWritePos);
    } else {
      // Buffer not yet full — only writePos bytes are valid samples.
      this.ring.copy(out, 0, 0, this.ringWritePos);
    }
    return Buffer.concat([wavHeader(out.length), out]);
  }

  /** Energy heuristic — skip decode invocation if the window is
   *  effectively silent. Cheap RMS over a downsampled view (every
   *  16th sample) to keep the timer tick light. */
  windowHasSignal() {
    const view = new Int16Array(this.ring.buffer, this.ring.byteOffset,
                                this.ring.byteLength / 2);
    let acc = 0, count = 0;
    for (let i = 0; i < view.length; i += 16) {
      const s = view[i];
      acc += s * s;
      count++;
    }
    if (count === 0) return false;
    const rms = Math.sqrt(acc / count);
    return rms > 200;          // ≈ -45 dBFS — well below typical SSB voice
  }

  maybeDecode() {
    if (this.closed) return;
    if (!this.ringFull && this.ringWritePos < SAMPLE_RATE * 2 * 4) return; // <4 s buffered
    if (!this.windowHasSignal()) return;
    const wav = this.snapshotWav();
    const wavPath = path.join(this.tmpDir, `win-${Date.now()}.wav`);
    try {
      writeFileSync(wavPath, wav);
    } catch (e) {
      this.opts.onStatus?.(`wav write failed: ${e.message}`);
      return;
    }
    // dsc_decode.py <wav> — exits 0 even when nothing decoded; the
    // payload only appears in stdout when a call was found.
    const child = spawn('python3', [DECODER, wavPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: SCRIPT_DIR,         // so the script can find dsc_common.py
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => {
      try { unlinkSync(wavPath); } catch {}
      if (this.closed) return;
      if (code !== 0) {
        process.stderr.write(`[dsc] decoder rc=${code} ${stderr.trim().slice(0, 200)}\n`);
        return;
      }
      const line = stdout.trim();
      if (!line) return;       // no DSC frame in this window
      // De-duplicate: the rolling buffer overlap means the same call
      // can be reported by 2–3 consecutive cycles. Hash the payload
      // and skip emit if unchanged from last time.
      if (line === this.lastEmittedHash) return;
      this.lastEmittedHash = line;
      this.opts.onText?.(line);
      // The Python decoder prints a multi-line summary; try to find
      // the MMSI + format-specifier for a structured event.
      const mmsiMatch = line.match(/MMSI[:\s]+(\d{6,9})/i);
      const fmtMatch  = line.match(/Format[:\s]+([A-Za-z- ]+)/i);
      this.opts.onEvent?.({
        raw: line, tsMs: Date.now(),
        mmsi: mmsiMatch?.[1], fmt: fmtMatch?.[1]?.trim(),
      });
    });
    child.on('error', (e) => {
      process.stderr.write(`[dsc] spawn error: ${e.message}\n`);
      try { unlinkSync(wavPath); } catch {}
    });
  }

  close() {
    this.closed = true;
    try { clearInterval(this.timer); } catch {}
    this.timer = null;
    try { rmSync(this.tmpDir, { recursive: true, force: true }); } catch {}
  }
}
