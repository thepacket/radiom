// ADS-B / Mode-S decoder — dump1090 in --ifile mode reading UC8
// (unsigned 8-bit complex) from stdin. Outputs aircraft beast/SBS
// messages on stdout per decoded squitter.
//
// 1090 MHz needs a 2 MS/s baseband — the RTL-SDR backend's IQ
// pipeline provides this directly. With a Kiwi source there's no
// way to reach 1090 MHz so the decoder will just sit idle.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'adsb', 'bin', 'dump1090');

export class AdsbDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    if (!existsSync(BIN)) { this.opts.onStatus?.('dump1090 missing — run `npm run build:adsb`'); return; }
    this.spawn();
  }

  spawn() {
    try {
      // --ifile -        : read IQ from stdin
      // --iformat SC16   : signed 16-bit interleaved (rtl_tcp bridge
      //                    output format — we already convert 8-bit
      //                    unsigned to int16 LE there so the wire shape
      //                    matches every other vendored binary).
      // --raw            : print raw beast messages on stdout
      this.proc = spawn(BIN, ['--ifile', '-', '--iformat', 'SC16', '--raw'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { this.opts.onStatus?.(`spawn failed: ${e.message}`); return; }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const text = c.toString().trimEnd();
      // Forward to fly logs for diagnostics — the in-app status only
      // shows the *last* stderr line, which is almost always the
      // boot banner ("dump1090-fa <ver> starting up") and not useful
      // when the actual issue is downstream.
      process.stderr.write(`[dump1090] ${text}\n`);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        // Suppress the startup banner from the status overlay; it
        // overwrites "ADSB starting…" with a meaningless string. Let
        // anything else (real errors, format mismatches) through.
        if (/starting up\.?$/.test(line)) continue;
        this.opts.onStatus?.(line.slice(0, 160));
      }
    });
    this.proc.on('exit', (code) => { if (!this.closed) this.opts.onStatus?.(`dump1090 exited code=${code}`); this.proc = null; });
    this.proc.on('error', (e) => this.opts.onStatus?.(`dump1090 error: ${e.message}`));
    this.opts.onStatus?.('listening');
  }

  consumeStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.opts.onText?.(line);
    }
  }

  /** Forward IQ bytes verbatim (already UC8 from RTL-SDR). */
  feed(buf) {
    if (this.closed || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    try { this.proc.stdin.write(buf); } catch {}
  }

  close() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
  }
}
