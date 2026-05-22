// SELCAL decoder — Node-side wrapper around `multimon-ng -a SELCAL`.
//
// SELCAL is the aviation HF / VHF selective-calling protocol: a
// 2-of-16 tone-pair sequence (4 tones total, two pairs of two
// simultaneous tones) used to alert specific aircraft on shared HF
// channels. Tone palette ranges 312.6 → 1479.1 Hz. Each call codes a
// 4-letter aircraft code (e.g. "AB-CD").
//
// Pipeline:
//
//   Kiwi 12 kHz int16 PCM
//      │  (12k → 22.05k linear-interp resampler, multimon's expected rate)
//      ▼
//   multimon-ng -t raw -a SELCAL -    (stdin / stdout)
//      │  text lines like "SELCAL: AB-CD"
//      ▼
//   WS  ──▶  client panel
//
// multimon-ng's raw audio input is locked to 22050 Hz mono int16 LE;
// there's no CLI flag to change it, so the resample happens in this
// bridge before the audio hits the binary.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'multimon', 'bin', 'multimon-ng');

const KIWI_RATE     = 12_000;
const MULTIMON_RATE = 22_050;

export class SelcalDecoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz
   * @param {(call: { code: string, raw: string, tsMs: number }) => void} [opts.onCall]
   * @param {(msg: string) => void} [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    // 12k → 22.05k linear resampler state (in/out ratio = 12000/22050 ≈ 0.5442).
    this.resamplePhase = 0;
    this.resamplePrev = 0;
    this.resampleScratch = new Int16Array(16384);
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('multimon-ng missing — run `npm run build:selcal`');
      return;
    }
    this.spawn();
  }

  spawn() {
    try {
      // -t raw           : raw 22050 Hz int16 LE on stdin
      // -a SELCAL        : enable SELCAL demodulator
      // -                : read from stdin
      // -q               : quiet (skip the banner / mode-list at startup)
      // multimon-ng prints decoded events as plain text lines on stdout.
      this.proc = spawn(BIN, ['-t', 'raw', '-a', 'SELCAL', '-q', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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
    this.opts.onStatus?.('listening (SELCAL)');
  }

  /** Parse multimon-ng's stdout. SELCAL emits one line per decode,
   *  typically of the form "SELCAL: ABCD" or "SELCAL: AB-CD". We
   *  extract the 4-letter code and forward as a structured event;
   *  raw text is also surfaced for any banner / extra lines. */
  consumeStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      // multimon line shapes seen in the wild:
      //   "SELCAL: AB-CD"
      //   "SELCAL: ABCD"
      //   "SELCAL: A B - C D"  (older builds put spaces between tones)
      const m = line.match(/SELCAL\s*[:\-]\s*([A-S\-\s]+)$/i);
      if (m) {
        const code = m[1].replace(/[\s\-]/g, '').toUpperCase();
        if (code.length === 4) {
          this.opts.onCall?.({ code, raw: line, tsMs: Date.now() });
          continue;
        }
      }
      // Anything else — surface as status so the operator can see it.
      this.opts.onStatus?.(line.slice(0, 160));
    }
  }

  /** Pipe a chunk of Kiwi 12 kHz int16 LE PCM into multimon-ng's
   *  stdin after upsampling to 22050 Hz with linear interpolation. */
  feed(samples) {
    if (this.closed || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    const n = samples.length;
    if (n === 0) return;
    // Worst-case output size = ceil(n * 22050 / 12000) ≈ 1.84 × n.
    const need = Math.ceil(n * 2) + 8;
    if (this.resampleScratch.length < need) this.resampleScratch = new Int16Array(need);
    const out = this.resampleScratch;
    let w = 0;
    const ratio = KIWI_RATE / MULTIMON_RATE; // < 1, so we emit > 1 output per input
    let phase = this.resamplePhase;
    let prev = this.resamplePrev;
    for (let i = 0; i < n; i++) {
      const cur = samples[i];
      while (phase < 1) {
        // Linearly interpolate between prev and cur.
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
