// LoRa bridge — wraps gr-lora_sdr's Python receiver. Reads CS16
// (int16 LE interleaved I/Q) on stdin, prints decoded packets on
// stdout. Default config: BW=125 kHz, SF=7, CR=4/5, LoRaWAN-style
// CRC, explicit header. Matches the most common public LoRa(WAN)
// traffic on EU868 / US915 / AS923.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'lora', 'bin', 'lora-decode');

export class LoraDecoder {
  /**
   * @param {object} opts
   * @param {number} [opts.bw]   125000 / 250000 / 500000 Hz
   * @param {number} [opts.sf]   7 .. 12
   * @param {number} [opts.cr]   1 .. 4  (4/5 .. 4/8)
   * @param {number} [opts.rate] input sample rate (≥ 2 × bw)
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('lora-decode missing — run `npm run build:lora`');
      return;
    }
    this.spawn();
  }

  spawn() {
    const bw   = this.opts.bw   ?? 125_000;
    const sf   = this.opts.sf   ?? 7;
    const cr   = this.opts.cr   ?? 1;
    const rate = this.opts.rate ?? Math.max(2 * bw, 500_000);
    try {
      this.proc = spawn(BIN, [
        '--bw', String(bw),
        '--sf', String(sf),
        '--cr', String(cr),
        '--rate', String(rate),
        '--has-crc', '1',
        '--impl-header', '0',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      for (const line of c.toString().trimEnd().split('\n'))
        if (line.trim()) this.opts.onStatus?.(line.slice(0, 200));
    });
    this.proc.on('exit', (code) => {
      if (!this.closed) this.opts.onStatus?.(`lora-decode exited code=${code}`);
      this.proc = null;
    });
    this.proc.on('error', (e) => this.opts.onStatus?.(`lora-decode error: ${e.message}`));
    this.opts.onStatus?.(`listening (BW=${bw / 1000}k SF=${sf} CR=4/${4 + cr})`);
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

  /** Pass CS16 IQ verbatim from the rtl_tcp bridge.
   *  When the format swap (`uc8`) is in effect the rtl_tcp bridge
   *  emits 8-bit; for LoRa we expect int16 so the shell sets format
   *  to int16 before activating. */
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
