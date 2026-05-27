// Time-signal decoder — DCF77 / WWVB / MSF / JJY. Single binary,
// sub-mode selectable via `?sub=` query. AM-modulated longwave time
// references used worldwide for clock sync, scientific reference,
// and navigation timing.
//
//   sub=dcf77  — Mainflingen DE, 77.5 kHz (default)
//   sub=wwvb   — Fort Collins US, 60 kHz
//   sub=msf    — Anthorn UK, 60 kHz
//   sub=jjy    — Japan, 40 / 60 kHz
//   sub=rwm    — Moscow RU, 4.996 / 9.996 / 14.996 MHz
//
// Reads int16 LE 8 kHz audio from stdin (output of an AM demod
// centred on the carrier; only the second-marker amplitude pattern
// matters, the rest of the audio is unused). Writes one decoded
// timestamp + status per second on stdout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'timesig', 'bin', 'timesig');

const SRC_RATE = 12_000;
const TS_RATE  = 8_000;

export class TimesigDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.subMode = opts.subMode || 'dcf77';
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    this.resamplePhase = 0;
    this.resamplePrev = 0;
    this.resampleScratch = new Int16Array(16384);
    if (!existsSync(BIN)) { this.opts.onStatus?.('timesig binary missing — run `npm run build:timesig`'); return; }
    this.spawn();
  }

  spawn() {
    try {
      // dokutan/dcf77-decode flags vary; the canonical invocation
      // reads raw audio from stdin and dumps decoded time to stdout.
      // Sub-mode passed via env so the binary (when it supports it)
      // can switch carriers; harmless for DCF77-only builds.
      this.proc = spawn(BIN, ['-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TIMESIG_MODE: this.subMode },
      });
    } catch (e) { this.opts.onStatus?.(`spawn failed: ${e.message}`); return; }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      for (const line of c.toString().trimEnd().split('\n'))
        if (line.trim()) this.opts.onStatus?.(line.slice(0, 160));
    });
    this.proc.on('exit', (code) => {
      if (!this.closed) this.opts.onStatus?.(`timesig exited code=${code}`);
      this.proc = null;
    });
    this.proc.on('error', (e) => this.opts.onStatus?.(`timesig error: ${e.message}`));
    this.opts.onStatus?.(`listening (${this.subMode.toUpperCase()})`);
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
    // 12 kHz → 8 kHz linear interp (ratio > 1 → emit < 1 out per in).
    const ratio = SRC_RATE / TS_RATE;
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
