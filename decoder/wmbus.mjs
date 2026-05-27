// Wireless M-Bus decoder — wmbusmeters, 868 MHz EU utility-meter
// telemetry. Reads raw int16 LE mono audio at 250 kHz from stdin
// (the wmbus FSK demod runs internal to wmbusmeters).
// Outputs JSON-line telegrams on stdout: meter type, address, value.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'wmbus', 'bin', 'wmbusmeters');

export class WmbusDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    if (!existsSync(BIN)) { this.opts.onStatus?.('wmbusmeters missing — run `npm run build:wmbus`'); return; }
    this.spawn();
  }

  spawn() {
    try {
      // --format=json     : JSON line per decoded telegram
      // --listento=t1,s1  : Tier 1 & 2 wm-bus modes
      // stdin:S1          : read raw rtl_sdr-compatible IQ on stdin
      this.proc = spawn(BIN, ['--format=json', '--listento=t1,s1', 'stdin:S1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { this.opts.onStatus?.(`spawn failed: ${e.message}`); return; }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      for (const line of c.toString().trimEnd().split('\n')) if (line.trim()) this.opts.onStatus?.(line.slice(0, 160));
    });
    this.proc.on('exit', (code) => { if (!this.closed) this.opts.onStatus?.(`wmbusmeters exited code=${code}`); this.proc = null; });
    this.proc.on('error', (e) => this.opts.onStatus?.(`wmbusmeters error: ${e.message}`));
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
