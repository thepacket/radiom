// Throb (fldigi) decoder — Node-side wrapper around the vendored
// fldigi Throb RX path. Same shape as the other fldigi-vendored
// decoders; the only mode-specific knob is `--mode=throb{1,2,4}` or
// `throbx{1,2,4}` for the ThrobX FEC variant.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'throb-fldigi', 'bin', 'throb-fldigi-decoder');

const VALID_MODES = new Set(['throb1','throb2','throb4','throbx1','throbx2','throbx4']);

export class ThrobFldigiDecoder {
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
    const mode  = VALID_MODES.has(this.opts.mode) ? this.opts.mode : 'throb1';
    const pitch = Number.isFinite(this.opts.pitchHz) ? this.opts.pitchHz : 1000;
    const args = [`--mode=${mode}`, `--pitch=${pitch}`];
    let proc;
    try {
      proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[throb-fldigi] spawn failed:', e.message, 'BIN=', BIN);
      this.opts.onStatus?.('throb-fldigi-decoder missing — run `npm run build:throb`');
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
      console.error('[throb-fldigi]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[throb-fldigi] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
      this.opts.onStatus?.(`throb-fldigi exited code=${code}`);
    });
    proc.on('error', (err) => {
      console.error('[throb-fldigi] error:', err.message, 'BIN=', BIN);
      this.opts.onStatus?.(`throb-fldigi error: ${err.message}`);
    });
    this.opts.onStatus?.(`listening (${mode})`);
  }
}
