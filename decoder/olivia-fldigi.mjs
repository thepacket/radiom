// Olivia (fldigi) decoder — Node-side wrapper around the vendored fldigi RX
// path. Spawns the native binary, pipes 12 kHz int16 PCM to its stdin,
// forwards decoded characters from its stdout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'olivia-fldigi', 'bin', 'olivia-fldigi-decoder');

export class OliviaFldigiDecoder {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleRate=12000]
   * @param {number} [opts.tones=32]
   * @param {number} [opts.bandwidth=1000]
   * @param {number} [opts.carrierHz=1500]
   * @param {(ch: string) => void} [opts.onChar]
   */
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
    const tones     = Number.isFinite(this.opts.tones)     ? this.opts.tones     : 32;
    const bandwidth = Number.isFinite(this.opts.bandwidth) ? this.opts.bandwidth : 1000;
    const carrier   = Number.isFinite(this.opts.carrierHz) ? this.opts.carrierHz : 1500;
    const args = [`--tones=${tones}`, `--bandwidth=${bandwidth}`, `--carrier=${carrier}`];
    if (Number.isFinite(this.opts.smargin)) args.push(`--smargin=${Math.round(this.opts.smargin)}`);
    if (Number.isFinite(this.opts.sinteg))  args.push(`--sinteg=${Math.round(this.opts.sinteg)}`);
    let proc;
    try {
      proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[olivia-fldigi] spawn failed:', e.message, 'BIN=', BIN);
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
      console.error('[olivia-fldigi]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[olivia-fldigi] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[olivia-fldigi] error:', err.message, 'BIN=', BIN);
    });
  }
}
