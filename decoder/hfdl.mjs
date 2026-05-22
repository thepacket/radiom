// HFDL decoder bridge — wraps the dumphfdl native binary.
//
// Different shape from cw/navtex/etc: dumphfdl consumes complex IQ
// samples (CS16 = interleaved int16, host-endian / little-endian),
// not real-audio mono PCM. KiwiSDR delivers BE int16 in its stereo
// wire format; this bridge byte-swaps each frame to LE before piping
// to dumphfdl's stdin. dumphfdl emits one JSON object per decoded
// HFDL message on stdout (also some banner text on startup, which we
// filter). We forward the JSON lines verbatim to the WS client.
//
// Sample rate: the upstream KiwiSDR IQ stream is 12 kHz complex.
// HFDL channels are ~3 kHz wide so we have plenty of Nyquist headroom;
// dumphfdl accepts arbitrary sample rates and does its own DDC.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.resolve(__dirname, '..', 'decoders', 'hfdl', 'bin');
const BIN     = path.join(BIN_DIR, 'dumphfdl');

export class HFDLDecoder {
  /**
   * @param {object} opts
   * @param {number} opts.freqKHz       HFDL channel centre (kHz)
   * @param {number} [opts.centerKHz]   Centre of the IQ stream (kHz, defaults to freqKHz)
   * @param {number} [opts.sampleRate=12000]
   * @param {(line: string) => void} [opts.onLine]   one JSON object per call
   * @param {(s: string)    => void} [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts     = { sampleRate: 12000, ...opts };
    this.proc     = null;
    this.bytesIn  = 0;
    this.linesOut = 0;
    this._buf     = '';
    this._spawn();
  }

  /**
   * Feed a raw IQ payload (int16 BE, interleaved I/Q) — the same bytes
   * KiwiSDR delivered after the 10-byte GPS header. Byte-swap to LE
   * happens here before writing to dumphfdl's stdin.
   */
  feed(iqBytes) {
    if (!this.proc || this.proc.exitCode != null) return;
    const n = iqBytes.length & ~1;          // round to even
    if (n === 0) return;
    // Allocate a fresh buffer per frame (tiny — 1024 samples × 2 bytes).
    const out = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i += 2) {
      // BE → LE byte swap.
      out[i]     = iqBytes[i + 1];
      out[i + 1] = iqBytes[i];
    }
    this.bytesIn += n;
    this.proc.stdin.write(out);
  }

  close() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill('SIGTERM'); } catch {}
    this.proc = null;
  }

  _spawn() {
    const center = Number.isFinite(this.opts.centerKHz) ? this.opts.centerKHz : this.opts.freqKHz;
    const args = [
      '--iq-file',       '-',
      '--sample-format', 'CS16',
      '--sample-rate',   String(this.opts.sampleRate),
      '--centerfreq',    String(center),
      '--output',        'decoded:json:file:path=-',
      String(this.opts.freqKHz),
    ];
    let proc;
    try {
      proc = spawn(BIN, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LD_LIBRARY_PATH: BIN_DIR + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') },
      });
    } catch (e) {
      console.error('[hfdl-decoder] spawn failed:', e.message, 'BIN=', BIN);
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
        // dumphfdl prints a banner before any JSON; ignore non-JSON.
        if (line[0] !== '{') continue;
        this.linesOut++;
        this.opts.onLine?.(line);
      }
    });
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString().trimEnd();
      if (s) console.error('[hfdl-decoder]', s);
    });
    proc.on('exit', (code, sig) => {
      console.error(`[hfdl-decoder] exit code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[hfdl-decoder] error:', err.message, 'BIN=', BIN);
    });
  }
}
