// VDL Mode 2 decoder — szpajder/dumpvdl2. 136.7–136.975 MHz aircraft
// data link (ACARS-over-D8PSK). Companion to dumphfdl on HF; same
// author, same wire shape.
//
// dumpvdl2 CLI gotchas (verified against src/dumpvdl2.c on master):
//   • --iq-file -        reads IQ from stdin (the "-" form is
//                          explicitly documented).
//   • --sample-format    accepts ONLY "U8" or "S16_LE". The help
//                          text says "S16LE" (no underscore) but the
//                          actual parser does strcmp(optarg, "S16_LE").
//                          Passing "S16" was a silent showstopper.
//   • --oversample N     sets sample_rate = 105000 * N. The radiom
//                          RfProfile for btnVdl2 feeds 1.05 MS/s, so
//                          oversample = 10.
//   • Frequencies are POSITIONAL args at the end of the command
//                          line — at least one is required. Without
//                          them dumpvdl2 errors out with "specify at
//                          least one frequency". We pass all eight
//                          standard 25-kHz-spaced VDL2 channels in
//                          the 136.7–136.975 MHz band so the decoder
//                          processes whatever the source is tuned to.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'vdl2', 'bin', 'dumpvdl2');

// Standard VDL2 channels in the 136 MHz band. dumpvdl2 expects them
// in Hz on the command line.
const VDL2_CHANNELS_HZ = [
  136_700_000, 136_725_000, 136_750_000, 136_775_000,
  136_800_000, 136_825_000, 136_850_000, 136_875_000,
  136_900_000, 136_925_000, 136_950_000, 136_975_000,
];

export class Vdl2Decoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('dumpvdl2 missing — run `npm run build:vdl2`');
      return;
    }
    this.spawn();
  }

  spawn() {
    const argv = [
      '--iq-file', '-',
      '--sample-format', 'S16_LE',
      '--oversample', '10',
      // Positional frequencies — dumpvdl2 demods each one in parallel.
      ...VDL2_CHANNELS_HZ.map(String),
    ];
    process.stderr.write(`[dumpvdl2] spawning: ${BIN} ${argv.join(' ')}\n`);
    try {
      this.proc = spawn(BIN, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      process.stderr.write(`[dumpvdl2] spawn threw: ${e.message}\n`);
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    process.stderr.write(`[dumpvdl2] spawned pid=${this.proc.pid}\n`);
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const text = c.toString().trimEnd();
      process.stderr.write(`[dumpvdl2] ${text}\n`);
      for (const line of text.split('\n')) if (line.trim()) this.opts.onStatus?.(line.slice(0, 160));
    });
    this.proc.on('exit', (code, signal) => {
      if (!this.closed) {
        const detail = `code=${code}${signal ? ` sig=${signal}` : ''}`;
        this.opts.onStatus?.(`dumpvdl2 exited ${detail}`);
        process.stderr.write(`[dumpvdl2] exited ${detail}\n`);
      }
      this.proc = null;
    });
    this.proc.on('error', (e) => {
      process.stderr.write(`[dumpvdl2] proc error: ${e.message}\n`);
      this.opts.onStatus?.(`dumpvdl2 error: ${e.message}`);
    });
    this.opts.onStatus?.('listening (VDL-2)');
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
    try { this.proc.stdin.write(buf); } catch { /* EPIPE on shutdown */ }
  }

  close() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
  }
}
