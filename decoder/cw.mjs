// CW decoder — Node-side wrapper around the vendored fldigi RX path.
//
// We spawn the native `cw-decoder` binary built from
// decoders/cw/{main.cpp, fldigi_glue.cpp, fldigi/*.cxx} and pipe 12 kHz
// int16 PCM into its stdin. The binary streams decoded characters back
// on stdout (no framing — every byte is a printable char). Public API
// (CWDecoder.feed / opts.onChar) is unchanged so server.mjs is untouched.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'cw', 'bin', 'cw-decoder');

export class CWDecoder {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleRate=12000]
   * @param {number} [opts.pitchHz=800] audio centre frequency for the matched filter
   * @param {number} [opts.wpm=18] initial WPM (decoder still adapts via WPM tracker)
   * @param {(ch: string) => void} [opts.onChar]
   * @param {(hz: number) => void} [opts.onPitch] — kept for API parity, no-op.
   */
  constructor(opts = {}) {
    this.opts  = opts;
    this.proc  = null;
    this.bytesIn = 0;
    this.charsOut = 0;
    this._spawn();
  }

  feed(/** @type {Int16Array} */ samples) {
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
    const o = this.opts;
    const num = (v) => Number.isFinite(+v) ? +v : null;
    if (num(o.pitchHz)    != null) args.push(`--pitch=${Math.round(o.pitchHz)}`);
    if (num(o.wpm)        != null) args.push(`--wpm=${Math.round(o.wpm)}`);
    if (num(o.lowerLimit) != null) args.push(`--lower=${Math.round(o.lowerLimit)}`);
    if (num(o.upperLimit) != null) args.push(`--upper=${Math.round(o.upperLimit)}`);
    if (num(o.range)      != null) args.push(`--range=${Math.round(o.range)}`);
    if (num(o.bandwidth)  != null) args.push(`--bw=${Math.round(o.bandwidth)}`);
    if (o.matchedFilter != null)   args.push(`--mfilt=${o.matchedFilter ? 1 : 0}`);
    if (num(o.attack)     != null) args.push(`--attack=${Math.round(o.attack)}`);
    if (num(o.decay)      != null) args.push(`--decay=${Math.round(o.decay)}`);
    if (o.lowercase != null)       args.push(`--lowercase=${o.lowercase ? 1 : 0}`);
    if (num(o.dashDot)    != null) args.push(`--dashdot=${o.dashDot}`);
    if (o.useSOM != null)          args.push(`--som=${o.useSOM ? 1 : 0}`);
    let proc;
    try {
      proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[cw-decoder] spawn failed:', e.message, 'BIN=', BIN);
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
      console.error('[cw-decoder]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[cw-decoder] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[cw-decoder] error:', err.message, 'BIN=', BIN);
    });
  }
}
