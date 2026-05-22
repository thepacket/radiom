// NAVTEX decoder — Node-side wrapper around the vendored fldigi RX path.
// Same shape as decoder/cw.mjs: spawn the native binary, pipe 12 kHz
// int16 PCM to its stdin, forward decoded characters from its stdout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'navtex', 'bin', 'navtex-decoder');

export class NAVTEXDecoder {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleRate=12000]
   * @param {'navtex'|'sitorb'} [opts.mode='navtex']
   * @param {(ch: string) => void} [opts.onChar]
   * @param {(s: string)  => void} [opts.onStatus]
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
    const args = [];
    if (this.opts.mode === 'sitorb') args.push('--mode=sitorb');
    if (Number.isFinite(this.opts.carrierHz)) args.push(`--carrier=${Math.round(this.opts.carrierHz)}`);
    let proc;
    try {
      proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[navtex-decoder] spawn failed:', e.message, 'BIN=', BIN);
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
      console.error('[navtex-decoder]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[navtex-decoder] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[navtex-decoder] error:', err.message, 'BIN=', BIN);
    });
  }
}
