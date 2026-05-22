// RTTY (fldigi) decoder — RX-only Node-side wrapper.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'rtty-fldigi', 'bin', 'rtty-fldigi-decoder');

export class RttyFldigiDecoder {
  constructor(opts = {}) {
    this.opts     = opts;
    this.proc     = null;
    this.bytesIn  = 0;
    this.charsOut = 0;
    this._spawn();
  }

  feed(samples) {
    if (!this.proc || this.proc.exitCode != null) return;
    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    this.bytesIn += buf.length;
    this.proc.stdin.write(buf);
  }

  close() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill('SIGTERM'); } catch {}
    this.proc = null;
  }

  _spawn() {
    const carrier = Number.isFinite(this.opts.carrierHz) ? this.opts.carrierHz : 1500;
    const baud    = Number.isFinite(this.opts.baud)      ? this.opts.baud      : 45.45;
    const shift   = Number.isFinite(this.opts.shift)     ? this.opts.shift     : 170;
    const bits    = Number.isFinite(this.opts.bits)      ? this.opts.bits      : 5;
    const stop    = Number.isFinite(this.opts.stop)      ? this.opts.stop      : 1.5;
    const args = [
      `--carrier=${carrier}`,
      `--baud=${baud}`,
      `--shift=${shift}`,
      `--bits=${bits}`,
      `--stop=${stop}`,
    ];
    let proc;
    try {
      proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[rtty-fldigi] spawn failed:', e.message, 'BIN=', BIN);
      return;
    }
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this.charsOut += chunk.length;
      const onChar = this.opts.onChar;
      if (onChar) for (const ch of chunk) onChar(ch);
    });
    proc.stderr.on('data', (chunk) => {
      console.error('[rtty-fldigi]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[rtty-fldigi] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[rtty-fldigi] error:', err.message, 'BIN=', BIN);
    });
  }
}
