// LTR (Logic Trunked Radio) bridge — GopherTrunk wrapped to handle
// LTR / LTR-Net control-channel decode. Reads CS16 IQ on stdin,
// writes JSON-per-event on stdout: channel number, LCN, talkgroup,
// unit ID, status (channel-grant / disconnect / etc.).
//
// LTR is the dominant trunking format on US business UHF (400/800
// MHz) since the late 1980s — still in service at smaller utilities
// and businesses who never migrated to P25 / DMR.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'ltr', 'bin', 'gophertrunk');

export class LtrDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    if (!existsSync(BIN)) { this.opts.onStatus?.('gophertrunk missing — run `npm run build:ltr`'); return; }
    this.spawn();
  }

  spawn() {
    try {
      // --protocol ltr  : select LTR / LTR-Net decoder
      // --source stdin  : read CS16 IQ from stdin
      // --rate 24000    : LTR sub-audible signalling fits in narrow
      //                   audio bandwidth; 24 kHz is the minimum
      //                   sample rate GopherTrunk's LTR pipeline
      //                   accepts (it does its own LPF + decimation
      //                   internally).
      // --output json   : structured stdout events
      this.proc = spawn(BIN, [
        '--protocol', 'ltr',
        '--source', 'stdin',
        '--rate', '24000',
        '--output', 'json',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { this.opts.onStatus?.(`spawn failed: ${e.message}`); return; }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      for (const line of c.toString().trimEnd().split('\n'))
        if (line.trim()) this.opts.onStatus?.(line.slice(0, 200));
    });
    this.proc.on('exit', (code) => {
      if (!this.closed) this.opts.onStatus?.(`gophertrunk exited code=${code}`);
      this.proc = null;
    });
    this.proc.on('error', (e) => this.opts.onStatus?.(`gophertrunk error: ${e.message}`));
    this.opts.onStatus?.('listening (LTR)');
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

  /** Pass CS16 IQ verbatim from the rtl_tcp bridge. */
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
