// RSID auto-classifier — Node-side child-process wrapper.
//
// Spawns the native `rsid-decoder` binary (vendored fldigi RSID receiver),
// pipes 12 kHz int16 PCM into its stdin, and parses NDJSON detection
// events from its stdout into JS callbacks.
//
// Each detection: { t: 'detect', mode: 'OLIVIA-8-500', id: <int>, freq: <Hz> }
// (id = the fldigi MODE_* enum value; mode is the canonical sname.)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'rsid', 'bin', 'rsid-decoder');

export class RsidDecoder {
  /**
   * @param {object} opts
   * @param {(ev: object) => void} [opts.onEvent]   Raw NDJSON event sink.
   * @param {(d: { mode: string, id: number, freq: number }) => void} [opts.onDetect]
   * @param {(msg: string) => void} [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.stdoutBuf = '';
    this._spawn();
  }

  feed(/** @type {Int16Array} */ samples) {
    if (!this.proc || this.proc.exitCode != null) return;
    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
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
      console.error('[rsid-decoder] spawn failed:', e.message, 'BIN=', BIN);
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    proc.stderr.on('data', (chunk) => {
      console.error('[rsid-decoder]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[rsid-decoder] exit code=${code} sig=${sig ?? '-'}`);
      this.opts.onStatus?.(`decoder exited code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[rsid-decoder] error:', err.message, 'BIN=', BIN);
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
      if (ev.t === 'detect') {
        this.opts.onDetect?.({
          mode: String(ev.mode ?? '?'),
          id:   ev.id | 0,
          freq: Number(ev.freq) || 0,
        });
      }
    }
  }
}
