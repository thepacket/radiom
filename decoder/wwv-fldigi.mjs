// WWV (fldigi) scope decoder — RX-only Node-side wrapper.
// The native binary writes framed binary to stdout:
//   "WV" magic (2 bytes) + uint16-LE count + count uint8 video samples.
// We parse those frames and forward each as a single binary message via
// opts.onFrame(Uint8Array).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'wwv-fldigi', 'bin', 'wwv-fldigi-decoder');

export class WwvFldigiDecoder {
  constructor(opts = {}) {
    this.opts     = opts;
    this.proc     = null;
    this.bytesIn  = 0;
    this.framesOut = 0;
    this._tail    = Buffer.alloc(0);
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
      console.error('[wwv-fldigi] spawn failed:', e.message, 'BIN=', BIN);
      return;
    }
    this.proc = proc;
    proc.stdout.on('data', (chunk) => this._consume(chunk));
    proc.stderr.on('data', (chunk) => {
      console.error('[wwv-fldigi]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[wwv-fldigi] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[wwv-fldigi] error:', err.message, 'BIN=', BIN);
    });
  }

  _consume(chunk) {
    let buf = Buffer.concat([this._tail, chunk]);
    while (buf.length >= 4) {
      if (buf[0] !== 0x57 /* 'W' */ || buf[1] !== 0x56 /* 'V' */) {
        // Resync — skip one byte and try again.
        buf = buf.subarray(1);
        continue;
      }
      const n = buf[2] | (buf[3] << 8);
      if (buf.length < 4 + n) break;
      const frame = buf.subarray(4, 4 + n);
      this.framesOut++;
      this.opts.onFrame?.(new Uint8Array(frame));
      buf = buf.subarray(4 + n);
    }
    this._tail = buf;
  }
}
