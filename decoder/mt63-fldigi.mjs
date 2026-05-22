// MT63 (fldigi) decoder — Node-side wrapper around the vendored fldigi RX
// path. Spawns the native binary, pipes 12 kHz int16 PCM to stdin, reads
// decoded characters from stdout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'mt63-fldigi', 'bin', 'mt63-fldigi-decoder');

const VALID_MODES = new Set(['500s','500l','1000s','1000l','2000s','2000l']);

export class Mt63FldigiDecoder {
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
    const mode    = VALID_MODES.has(this.opts.mode) ? this.opts.mode : '1000l';
    const carrier = Number.isFinite(this.opts.carrierHz) ? this.opts.carrierHz : 1500;
    const args = [`--mode=${mode}`, `--carrier=${carrier}`];
    if (this.opts.integration === 'short' || this.opts.integration === 'long') {
      args.push(`--integration=${this.opts.integration}`);
    }
    if (this.opts.eightBit != null) args.push(`--8bit=${this.opts.eightBit ? 1 : 0}`);
    let proc;
    try {
      proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[mt63-fldigi] spawn failed:', e.message, 'BIN=', BIN);
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
      console.error('[mt63-fldigi]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[mt63-fldigi] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[mt63-fldigi] error:', err.message, 'BIN=', BIN);
    });
  }
}
