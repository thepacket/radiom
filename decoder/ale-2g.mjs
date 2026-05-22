// ALE 2G decoder — Node-side wrapper around the LinuxALE-vendored binary.
// Same shape as decoder/navtex.mjs: spawn the native binary, pipe 12 kHz
// int16 PCM to its stdin, forward decoded lines from its stdout. The
// upstream LinuxALE writes complete lines (one ALE word per line, like
// "[12:34:56] [TO] ABC" or "[FROM] XYZ"), so we surface them as line
// events rather than per-character.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'ale-2g', 'bin', 'ale-2g-decoder');

export class ALE2GDecoder {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleRate=12000]
   * @param {(line: string) => void} [opts.onLine]
   * @param {(s: string)    => void} [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts    = opts;
    this.proc    = null;
    this.bytesIn = 0;
    this.linesOut = 0;
    this._buf    = '';
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
    let proc;
    try {
      proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[ale-2g-decoder] spawn failed:', e.message, 'BIN=', BIN);
      return;
    }
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this._buf += chunk;
      let nl;
      while ((nl = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, nl).replace(/\r$/, '');
        this._buf = this._buf.slice(nl + 1);
        if (line.length === 0) continue;
        this.linesOut++;
        this.opts.onLine?.(line);
      }
    });
    proc.stderr.on('data', (chunk) => {
      console.error('[ale-2g-decoder]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[ale-2g-decoder] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[ale-2g-decoder] error:', err.message, 'BIN=', BIN);
    });
  }
}
