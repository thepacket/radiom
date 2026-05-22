// PSK (fldigi) decoder — Node-side wrapper around the vendored fldigi RX
// path. Same shape as decoder/navtex.mjs: spawn the native binary, pipe
// 12 kHz int16 PCM to its stdin, forward decoded characters from stdout.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'psk-fldigi', 'bin', 'psk-fldigi-decoder');

const VALID_MODES = new Set([
  'bpsk31', 'bpsk63', 'bpsk63f', 'bpsk125', 'bpsk250', 'bpsk500', 'bpsk1000',
  'qpsk31', 'qpsk63', 'qpsk125', 'qpsk250', 'qpsk500',
  '8psk125', '8psk125fl', '8psk125f',
  '8psk250', '8psk250fl', '8psk250f',
  '8psk500', '8psk500f',
  '8psk1000', '8psk1000f', '8psk1200f',
  'psk125r', 'psk250r', 'psk500r', 'psk1000r',
]);

export class PSKFldigiDecoder {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleRate=12000]
   * @param {string} [opts.mode='bpsk31']
   * @param {number} [opts.pitch=1000]
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
    const mode  = VALID_MODES.has(this.opts.mode) ? this.opts.mode : 'bpsk31';
    const pitch = Number.isFinite(this.opts.pitch) ? this.opts.pitch : 1000;
    const args = [`--mode=${mode}`, `--pitch=${pitch}`];
    if (Number.isFinite(this.opts.acqSn))       args.push(`--acqsn=${this.opts.acqSn}`);
    if (Number.isFinite(this.opts.searchRange)) args.push(`--search=${Math.round(this.opts.searchRange)}`);
    let proc;
    try {
      proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[psk-fldigi] spawn failed:', e.message, 'BIN=', BIN);
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
      console.error('[psk-fldigi]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[psk-fldigi] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[psk-fldigi] error:', err.message, 'BIN=', BIN);
    });
  }
}
