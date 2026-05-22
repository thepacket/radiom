// THOR (fldigi) decoder — RX-only Node-side wrapper around the vendored
// fldigi RX path. Spawns the native binary, pipes 12 kHz int16 PCM to
// stdin, reads decoded characters from stdout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'thor-fldigi', 'bin', 'thor-fldigi-decoder');

const VALID_MODES = new Set(['thor4','thor5','thor8','thor11','thor16','thor22','thor25x4','thor50x1','thor50x2','thor100','thormicro']);

export class ThorFldigiDecoder {
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
    const mode    = VALID_MODES.has(this.opts.mode) ? this.opts.mode : 'thor16';
    const carrier = Number.isFinite(this.opts.carrierHz) ? this.opts.carrierHz : 1500;
    const args = [`--mode=${mode}`, `--carrier=${carrier}`];
    let proc;
    try {
      proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[thor-fldigi] spawn failed:', e.message, 'BIN=', BIN);
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
      console.error('[thor-fldigi]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[thor-fldigi] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[thor-fldigi] error:', err.message, 'BIN=', BIN);
    });
  }
}
