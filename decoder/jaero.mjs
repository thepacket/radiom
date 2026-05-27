// AERO (Inmarsat AERO Classic) — alphafox02/inmarsat-sniffer.
//
// Architecture change from the previous JAERO scaffold: the binary
// expects raw L-band IQ (not audio), and reads from a file path
// (not stdin). The bridge wires this with a named pipe (fifo):
//
//   1. mkfifo /tmp/aero-<pid>.fifo
//   2. spawn inmarsat-sniffer -f /tmp/aero-<pid>.fifo --format=cs16 --mode=aero
//   3. Node opens the fifo for writing — Linux kernel buffers
//      between writer (us) and reader (decoder), so this acts as
//      a stdin equivalent.
//
// Source must be rtl_tcp at L-band (≥1 Ms/s recommended).

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'jaero', 'bin', 'jaero-cli');

export class JaeroDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    this.fifoPath = path.join(tmpdir(), `radiom-aero-${process.pid}-${Date.now()}.fifo`);
    this.fifoFd = -1;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('jaero-cli (inmarsat-sniffer) missing — run `npm run build:jaero`');
      return;
    }
    try {
      execSync(`mkfifo ${this.fifoPath}`);
    } catch (e) {
      this.opts.onStatus?.(`mkfifo failed: ${e.message}`);
      return;
    }
    this.spawn();
  }

  spawn() {
    try {
      // -f <fifo>         : read IQ from the named pipe
      // --format=cs16     : signed-16-bit interleaved (matches our
      //                     rtl_tcp bridge default output)
      // --mode=aero       : AERO Classic decoder path (Qt-stripped
      //                     JAERO DSP); STD-C in this same binary is
      //                     accessed via --mode=stdc on a separate
      //                     bridge instance (we run them as siblings).
      // inmarsat-sniffer requires --satellite to pick the channel plan.
      // 4F3 covers the Americas (Atlantic Ocean Region West, ~98°W); we
      // default to that since it's upstream's reference example.
      // Override via JAERO_SATELLITE env (3F5 = AOR-E, AF1 = IOR, F1 = POR).
      const sat = process.env.JAERO_SATELLITE || '4F3';
      this.proc = spawn(BIN, [
        '-f', this.fifoPath,
        '--format=cs16',
        '--mode=aero',
        `--satellite=${sat}`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const text = c.toString().trimEnd();
      process.stderr.write(`[jaero-cli] ${text}\n`);
      for (const line of text.split('\n'))
        if (line.trim()) this.opts.onStatus?.(line.slice(0, 200));
    });
    this.proc.on('exit', (code, signal) => {
      if (!this.closed) {
        // signal is the actual kill reason when code=null (libc abort,
        // segfault, EPIPE while writing to fifo, …). Surface both so
        // the status overlay shows e.g. "exited code=null sig=SIGPIPE".
        const detail = `code=${code}${signal ? ` sig=${signal}` : ''}`;
        this.opts.onStatus?.(`jaero-cli exited ${detail}`);
        process.stderr.write(`[jaero-cli] exited ${detail}\n`);
      }
      this.proc = null;
    });
    this.proc.on('error', (e) => this.opts.onStatus?.(`jaero-cli error: ${e.message}`));
    this.opts.onStatus?.('listening (Inmarsat AERO Classic via inmarsat-sniffer)');
    // Open the fifo for writing AFTER spawning — opening blocks until
    // a reader is present (the decoder's `-f` flag opens the read end
    // when it starts). Brief delay to let the child get there first.
    setTimeout(() => {
      try {
        this.fifoFd = openSync(this.fifoPath, 'w');
      } catch (e) {
        this.opts.onStatus?.(`fifo open (write) failed: ${e.message}`);
      }
    }, 300);
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

  /** Pass IQ bytes (CS16 int16 LE interleaved) verbatim from the
   *  rtl_tcp bridge into the fifo. The shell sets the rtl_tcp output
   *  format to 'int16' via the RfProfile for `btnJaero`. */
  feed(buf) {
    if (this.closed || this.fifoFd < 0) return;
    try { writeSync(this.fifoFd, buf); } catch { /* EPIPE etc. */ }
  }

  close() {
    this.closed = true;
    try { if (this.fifoFd >= 0) closeSync(this.fifoFd); } catch {}
    this.fifoFd = -1;
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
    try { unlinkSync(this.fifoPath); } catch {}
  }
}
