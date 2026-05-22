// FSQ (fldigi) decoder — RX-only Node-side wrapper around the vendored
// fldigi RX path. Spawns the native binary, pipes 12 kHz int16 PCM to
// stdin, reads decoded characters from stdout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'fsq-fldigi', 'bin', 'fsq-fldigi-decoder');

const VALID_BAUDS = new Set([1.5, 2, 3, 4.5, 6]);

export class FsqFldigiDecoder {
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
    const baud    = VALID_BAUDS.has(this.opts.baud) ? this.opts.baud : 3;
    const args = [`--carrier=${carrier}`, `--baud=${baud}`];
    let proc;
    try {
      proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[fsq-fldigi] spawn failed:', e.message, 'BIN=', BIN);
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
      console.error('[fsq-fldigi]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[fsq-fldigi] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[fsq-fldigi] error:', err.message, 'BIN=', BIN);
    });
  }
}
