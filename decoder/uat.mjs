// UAT 978 MHz decoder — flightaware/dump978-fa.
//
// US general-aviation ADS-B variant. The flightaware fork (replacing
// the archived mutability/dump978) is a Boost::program_options C++
// binary with explicit input + format flags — different CLI shape
// from dump1090-fa.
//
// Wire:
//   --stdin             : read sample bytes from stdin
//   --format CS16H      : signed-16-bit interleaved IQ (host byte
//                          order). Matches the cs16 wire format
//                          radiom's OWRX / rtl_tcp bridge already
//                          emits. (mutability/dump978 took uc8 by
//                          default; the flightaware fork makes you
//                          declare it explicitly.)
//   --raw-stdout        : print raw UAT frames on stdout (no TCP
//                          server needed; the bridge consumes stdout
//                          line-by-line).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'uat', 'bin', 'dump978');

export class UatDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('dump978 missing — run `npm run build:uat`');
      return;
    }
    this.spawn();
  }

  spawn() {
    const argv = ['--stdin', '--format', 'CS16H', '--raw-stdout'];
    process.stderr.write(`[dump978] spawning: ${BIN} ${argv.join(' ')}\n`);
    try {
      this.proc = spawn(BIN, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      process.stderr.write(`[dump978] spawn threw: ${e.message}\n`);
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    process.stderr.write(`[dump978] spawned pid=${this.proc.pid}\n`);
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const text = c.toString().trimEnd();
      process.stderr.write(`[dump978] ${text}\n`);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        // Skip the startup banner so the panel status doesn't get
        // overwritten with version chatter.
        if (/starting up|\bversion\b/i.test(line)) continue;
        this.opts.onStatus?.(line.slice(0, 160));
      }
    });
    this.proc.on('exit', (code, signal) => {
      if (!this.closed) {
        const detail = `code=${code}${signal ? ` sig=${signal}` : ''}`;
        this.opts.onStatus?.(`dump978 exited ${detail}`);
        process.stderr.write(`[dump978] exited ${detail}\n`);
      }
      this.proc = null;
    });
    this.proc.on('error', (e) => {
      process.stderr.write(`[dump978] proc error: ${e.message}\n`);
      this.opts.onStatus?.(`dump978 error: ${e.message}`);
    });
    this.opts.onStatus?.('listening (UAT 978 MHz)');
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

  /** Pass cs16 IQ bytes verbatim into dump978's stdin. The RfProfile
   *  for btnUat sets the source layer to int16 (cs16). */
  feed(buf) {
    if (this.closed || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    try { this.proc.stdin.write(buf); } catch { /* EPIPE on shutdown */ }
  }

  close() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
  }
}
