// TETRAPOL decoder — sysmocom/tetrapol-kit, 380–400 MHz GMSK 8000 bps
// public-safety / EU PMR. Audio-in / text-out. Sample rate expected
// 80 kHz; we upsample 12 kHz → 80 kHz with linear interp.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'tetrapol', 'bin', 'tetrapol');

const SRC_RATE = 12_000;
const DST_RATE = 80_000;

export class TetrapolDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    this.resamplePhase = 0;
    this.resamplePrev = 0;
    this.resampleScratch = new Int16Array(65536);
    if (!existsSync(BIN)) { this.opts.onStatus?.('tetrapol missing — run `npm run build:tetrapol`'); return; }
    this.spawn();
  }

  spawn() {
    try {
      this.proc = spawn(BIN, ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { this.opts.onStatus?.(`spawn failed: ${e.message}`); return; }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const text = c.toString().trimEnd();
      for (const line of text.split('\n')) if (line.trim()) this.opts.onStatus?.(line.slice(0, 160));
    });
    this.proc.on('exit', (code) => { if (!this.closed) this.opts.onStatus?.(`tetrapol exited code=${code}`); this.proc = null; });
    this.proc.on('error', (e) => this.opts.onStatus?.(`tetrapol error: ${e.message}`));
    this.opts.onStatus?.('listening');
  }

  consumeStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.opts.onText?.(line);
    }
  }

  feed(samples) {
    if (this.closed || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    const n = samples.length;
    if (n === 0) return;
    const ratio = SRC_RATE / DST_RATE;        // < 1 → emit > 1 out per in
    const need = Math.ceil(n / ratio) + 8;
    if (this.resampleScratch.length < need) this.resampleScratch = new Int16Array(need);
    const out = this.resampleScratch;
    let w = 0, phase = this.resamplePhase, prev = this.resamplePrev;
    for (let i = 0; i < n; i++) {
      const cur = samples[i];
      while (phase < 1) {
        const y = prev + (cur - prev) * phase;
        out[w++] = Math.max(-32768, Math.min(32767, y | 0));
        phase += ratio;
      }
      phase -= 1; prev = cur;
    }
    this.resamplePhase = phase; this.resamplePrev = prev;
    try { this.proc.stdin.write(Buffer.from(out.buffer, out.byteOffset, w * 2)); } catch {}
  }

  close() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
  }
}
