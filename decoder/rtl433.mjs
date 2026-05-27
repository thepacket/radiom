// rtl_433 bridge — the ISM-band protocol zoo. Reads UC8 IQ on stdin,
// writes JSON one-line-per-decode on stdout. Each line is a fully
// structured device decode: model, id, channel, battery, temperature,
// humidity, pressure, water flow, TPMS pressure, garage code, etc.
//
// Operator picks the centre freq via the RF profile (default 433.92
// MHz for most consumer telemetry; 868.30 / 915.00 also common).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'rtl433', 'bin', 'rtl_433');

export class Rtl433Decoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    if (!existsSync(BIN)) { this.opts.onStatus?.('rtl_433 missing — run `npm run build:rtl433`'); return; }
    this.spawn();
  }

  spawn() {
    // rtl_433's -r flag takes a format:path spec. Plain `-r -` is
    // ambiguous — file_info_parse_filename can't infer the format
    // from a path with no extension, so we explicitly pin cu8 (the
    // uint8 IQ format every rtl_tcp source emits).
    //
    // -r cu8:-        : read uint8 IQ from stdin
    // -F json         : structured output on stdout
    // -s 250k         : 250 kHz sample rate (matches the default
    //                   rtl_tcp output AND rtl_433's default; tune the
    //                   source layer to match if you change this)
    // -M time:iso     : ISO 8601 timestamps in each event
    // -M protocol     : annotate each event with protocol number
    // -A              : analyse all known protocols
    const argv = [
      '-r', 'cu8:-',
      '-F', 'json',
      '-s', '250000',
      '-M', 'time:iso',
      '-M', 'protocol',
      '-A',
    ];
    process.stderr.write(`[rtl_433] spawning: ${BIN} ${argv.join(' ')}\n`);
    try {
      this.proc = spawn(BIN, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      process.stderr.write(`[rtl_433] spawn threw: ${e.message}\n`);
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    process.stderr.write(`[rtl_433] spawned pid=${this.proc.pid}\n`);
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const text = c.toString().trimEnd();
      process.stderr.write(`[rtl_433] ${text}\n`);
      for (const line of text.split('\n')) if (line.trim()) this.opts.onStatus?.(line.slice(0, 160));
    });
    this.proc.on('exit', (code, signal) => {
      if (!this.closed) {
        const detail = `code=${code}${signal ? ` sig=${signal}` : ''}`;
        this.opts.onStatus?.(`rtl_433 exited ${detail}`);
        process.stderr.write(`[rtl_433] exited ${detail}\n`);
      }
      this.proc = null;
    });
    this.proc.on('error', (e) => {
      process.stderr.write(`[rtl_433] proc error: ${e.message}\n`);
      this.opts.onStatus?.(`rtl_433 error: ${e.message}`);
    });
    this.opts.onStatus?.('listening (~200 ISM protocols)');
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

  /** Pass UC8 IQ bytes verbatim from the rtl_tcp bridge. */
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
