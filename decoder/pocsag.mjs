// POCSAG decoder — Node-side wrapper around `multimon-ng -a POCSAG{512,1200,2400}`.
//
// POCSAG (Post Office Code Standardisation Advisory Group) is the
// standard pager / one-way paging protocol used on HF, VHF, and UHF.
// Three baud variants: 512, 1200, 2400. multimon-ng decodes all three
// when fed simultaneously (-a POCSAG512 -a POCSAG1200 -a POCSAG2400).
//
// Pipeline (mirrors selcal.mjs):
//
//   Kiwi 12 kHz int16 PCM
//      │  (12k → 22.05k linear-interp resampler, multimon's expected rate)
//      ▼
//   multimon-ng -t raw -a POCSAG512/1200/2400 -    (stdin / stdout)
//      │  text lines like "POCSAG1200: Address: 0123456 Function: 3 Alpha: HELLO"
//      ▼
//   WS  ──▶  client panel
//
// multimon-ng's raw audio input is locked to 22050 Hz mono int16 LE.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'multimon', 'bin', 'multimon-ng');

const KIWI_RATE     = 12_000;
const MULTIMON_RATE = 22_050;

export class PocsagDecoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz
   * @param {(page: {
   *   baud: number, address: string, fn: number,
   *   kind: 'alpha' | 'numeric' | 'tone',
   *   payload: string, raw: string, tsMs: number,
   * }) => void} [opts.onPage]
   * @param {(msg: string) => void} [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    this.resamplePhase = 0;
    this.resamplePrev = 0;
    this.resampleScratch = new Int16Array(16384);
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('multimon-ng missing — run `npm run build:selcal` (shared binary)');
      return;
    }
    this.spawn();
  }

  spawn() {
    try {
      // -a POCSAG{512,1200,2400}: enable all three baud variants.
      this.proc = spawn(BIN, [
        '-t', 'raw',
        '-a', 'POCSAG512',
        '-a', 'POCSAG1200',
        '-a', 'POCSAG2400',
        '-q', '-',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.consumeStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trimEnd();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/error|fail|warn/i.test(t)) this.opts.onStatus?.(`[stderr] ${t.slice(0, 120)}`);
      }
    });
    this.proc.on('exit', (code) => {
      if (!this.closed) this.opts.onStatus?.(`multimon-ng exited code=${code}`);
      this.proc = null;
    });
    this.proc.on('error', (e) => this.opts.onStatus?.(`multimon-ng error: ${e.message}`));
    this.opts.onStatus?.('listening (POCSAG 512/1200/2400)');
  }

  /** Parse multimon-ng POCSAG output. Common line shapes:
   *    POCSAG512:  Address:   123456  Function: 0  Alpha:   HELLO
   *    POCSAG1200: Address:  0987654  Function: 1  Numeric: 12345
   *    POCSAG2400: Address:  0000123  Function: 3  Tone only
   */
  consumeStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const m = /^POCSAG(\d+):\s+Address:\s*(\S+)\s+Function:\s*(\d+)(?:\s+(Alpha|Numeric|Tone)(?:\s*:?\s*(.*))?)?/i.exec(line);
      if (m) {
        const baud = +m[1];
        const address = m[2];
        const fn = +m[3];
        const kindRaw = (m[4] || 'tone').toLowerCase();
        const kind = kindRaw === 'alpha' ? 'alpha' : kindRaw === 'numeric' ? 'numeric' : 'tone';
        const payload = (m[5] || '').trim();
        this.opts.onPage?.({ baud, address, fn, kind, payload, raw: line, tsMs: Date.now() });
        continue;
      }
      this.opts.onStatus?.(line.slice(0, 160));
    }
  }

  /** 12 kHz → 22.05 kHz linear resampler, identical to SelcalDecoder. */
  feed(samples) {
    if (this.closed || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    const n = samples.length;
    if (n === 0) return;
    const need = Math.ceil(n * 2) + 8;
    if (this.resampleScratch.length < need) this.resampleScratch = new Int16Array(need);
    const out = this.resampleScratch;
    let w = 0;
    const ratio = KIWI_RATE / MULTIMON_RATE;
    let phase = this.resamplePhase;
    let prev = this.resamplePrev;
    for (let i = 0; i < n; i++) {
      const cur = samples[i];
      while (phase < 1) {
        const y = prev + (cur - prev) * phase;
        out[w++] = Math.max(-32768, Math.min(32767, y | 0));
        phase += ratio;
      }
      phase -= 1;
      prev = cur;
    }
    this.resamplePhase = phase;
    this.resamplePrev = prev;
    try {
      this.proc.stdin.write(Buffer.from(out.buffer, out.byteOffset, w * 2));
    } catch {}
  }

  close() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
  }
}
