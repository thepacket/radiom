// HF WEFAX decoder — Node-side child-process wrapper.
//
// Spawns the native `wefax-decoder` binary built from decoders/wefax/wrapper.cpp,
// pipes 12 kHz int16 PCM into its stdin, and parses NDJSON events from its
// stdout into JS callbacks.
//
// Stage-1: the binary emits a synthetic gradient image so the WS / UI plumbing
// can be exercised end-to-end. The real fldigi `fax_implementation` port lands
// in a follow-up; this wrapper does not change.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'wefax', 'bin', 'wefax-decoder');

export class WefaxDecoder {
  /**
   * @param {object} opts
   * @param {(ev: object) => void} [opts.onEvent]   Raw NDJSON event sink.
   * @param {(msg: string) => void} [opts.onStatus]
   * @param {(meta: object) => void} [opts.onImageStart]
   * @param {(row: { seq: number, data: Buffer }) => void} [opts.onRow]
   * @param {(meta: object) => void} [opts.onImageEnd]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.stdoutBuf = '';
    this.bytesIn = 0;
    this.rowsOut = 0;
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
    let proc;
    try {
      proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[wefax-decoder] spawn failed:', e.message, 'BIN=', BIN);
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      console.error('[wefax-decoder]', s.trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[wefax-decoder] exit code=${code} sig=${sig ?? '-'}`);
      this.opts.onStatus?.(`decoder exited code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[wefax-decoder] error:', err.message, 'BIN=', BIN);
      this.opts.onStatus?.(`decoder error: ${err.message}`);
    });
  }

  _onStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      this.opts.onEvent?.(ev);
      switch (ev.t) {
        case 'status':      this.opts.onStatus?.(ev.msg ?? ''); break;
        case 'image-start': this.opts.onImageStart?.(ev); break;
        case 'image-end':   this.opts.onImageEnd?.(ev); break;
        case 'row': {
          this.rowsOut++;
          const data = Buffer.from(ev.data ?? '', 'base64');
          this.opts.onRow?.({ seq: ev.seq | 0, data });
          break;
        }
      }
    }
  }
}
