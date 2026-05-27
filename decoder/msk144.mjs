// MSK144 decoder — wsjt-x's meteor-scatter mode. 144 baud MSK, 15 s
// T/R period. msk144d processes a 12 kHz mono int16 WAV of a single
// 15-second slot and prints any decoded short messages on stdout.
//
// Pipeline mirrors jt9.mjs / fst4.mjs / wspr.mjs:
//   1. Buffer 12 kHz int16 PCM in memory, 15 s per slot.
//   2. At UTC-aligned :00/:15/:30/:45 boundaries, swap to a new buffer.
//   3. After ~14 s of capture, write the previous slot to a WAV file
//      and spawn `msk144d <wav>`.
//   4. Parse stdout: lines like "2025-03-15 12:34 ... K1ABC W2DEF FN20".

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'msk144', 'bin', 'msk144d');

const SR     = 12_000;
const PERIOD_MS  = 15_000;
const CAPTURE_MS = 14_000;
const BUF_SIZE   = SR * (PERIOD_MS / 1000);

function writeWav(filePath, samples) {
  const dataBytes = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  const buf = Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, dataBytes)]);
  writeFileSync(filePath, buf);
}

export class Msk144Decoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.buf = null;
    this.bufPos = 0;
    this.closed = false;
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-msk144-'));
    if (!existsSync(BIN)) this.opts.onStatus?.('msk144d missing — run `npm run build:msk144`');
    this.scheduleNextPeriod();
  }

  feed(samples) {
    if (this.closed || !this.buf) return;
    const room = BUF_SIZE - this.bufPos;
    const take = Math.min(samples.length, room);
    if (take <= 0) return;
    this.buf.set(samples.subarray(0, take), this.bufPos);
    this.bufPos += take;
  }

  scheduleNextPeriod() {
    if (this.closed) return;
    const now = Date.now();
    // Align to next :00/:15/:30/:45 second boundary.
    const nextBoundary = Math.ceil(now / PERIOD_MS) * PERIOD_MS;
    setTimeout(() => this.startPeriod(), nextBoundary - now);
  }

  startPeriod() {
    if (this.closed) return;
    // Decode the *previous* buffer (if any) before starting the new one.
    if (this.buf && this.bufPos > SR * 5) {     // need ≥5 s to bother
      this.spawnDecode(this.buf.subarray(0, this.bufPos));
    }
    this.buf = new Int16Array(BUF_SIZE);
    this.bufPos = 0;
    this.opts.onStatus?.(`capturing slot @ ${new Date().toISOString().slice(11, 19)}`);
    setTimeout(() => this.startPeriod(), PERIOD_MS);
  }

  spawnDecode(slice) {
    const wavPath = path.join(this.tmpDir, `slot-${Date.now()}.wav`);
    try { writeWav(wavPath, slice); } catch { return; }
    const proc = spawn(BIN, [wavPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.on('exit', () => {
      for (const line of stdout.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        this.opts.onSpot?.({ raw: t, tsMs: Date.now(), dialKHz: this.opts.dialFreqKHz?.() ?? 0 });
      }
      try { rmSync(wavPath); } catch {}
    });
    proc.on('error', (e) => this.opts.onStatus?.(`msk144d error: ${e.message}`));
  }

  close() {
    this.closed = true;
    try { rmSync(this.tmpDir, { recursive: true, force: true }); } catch {}
  }
}
