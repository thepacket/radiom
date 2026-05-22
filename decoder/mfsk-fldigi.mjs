// MFSK (fldigi) decoder — Node-side wrapper around the vendored fldigi RX
// path. Spawns the native binary, pipes 12 kHz int16 PCM to stdin, reads
// decoded characters from stdout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'mfsk-fldigi', 'bin', 'mfsk-fldigi-decoder');

const VALID_MODES = new Set(['mfsk4','mfsk8','mfsk11','mfsk16','mfsk22','mfsk31','mfsk32','mfsk64','mfsk128']);

export class MfskFldigiDecoder {
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
    const mode  = VALID_MODES.has(this.opts.mode) ? this.opts.mode : 'mfsk16';
    const pitch = Number.isFinite(this.opts.pitchHz) ? this.opts.pitchHz : 1500;
    const args = [`--mode=${mode}`, `--pitch=${pitch}`];
    let proc;
    try {
      proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[mfsk-fldigi] spawn failed:', e.message, 'BIN=', BIN);
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
      console.error('[mfsk-fldigi]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[mfsk-fldigi] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[mfsk-fldigi] error:', err.message, 'BIN=', BIN);
    });
  }
}
