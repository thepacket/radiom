// RDS subcarrier decoder — windytan/redsea. Reads int16 LE mono
// audio sampled at 171 kHz (the 57 kHz RDS subcarrier × 3) from
// stdin, writes JSON RDS groups on stdout: station name (PS),
// program type (PTY), radiotext (RT), traffic info, alt freqs.
//
// For the typical FM-broadcast WBFM passband (200 kHz), the
// audio path needs to expose the demodulated multiplex (MPX)
// signal, not just the 50µs-deemphasised mono audio. On Kiwi
// connections this isn't available; OWRX servers in `wfm` mode
// likewise deliver post-deemph audio. The cleanest path is to
// feed redsea from the IQ pipeline of an RTL-SDR backend tuned
// to an FM station.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'rds', 'bin', 'redsea');

export class RdsDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    if (!existsSync(BIN)) { this.opts.onStatus?.('redsea missing — run `npm run build:rds`'); return; }
    this.spawn();
  }

  spawn() {
    try {
      // -r 171000  : input rate (171 kHz raw MPX)
      // -p         : pretty-print JSON
      this.proc = spawn(BIN, ['-r', '171000', '-p'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { this.opts.onStatus?.(`spawn failed: ${e.message}`); return; }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      for (const line of c.toString().trimEnd().split('\n')) if (line.trim()) this.opts.onStatus?.(line.slice(0, 160));
    });
    this.proc.on('exit', (code) => { if (!this.closed) this.opts.onStatus?.(`redsea exited code=${code}`); this.proc = null; });
    this.proc.on('error', (e) => this.opts.onStatus?.(`redsea error: ${e.message}`));
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

  feed(samples) {
    if (this.closed || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    if (samples.length === 0) return;
    try { this.proc.stdin.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)); } catch {}
  }

  close() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
  }
}
