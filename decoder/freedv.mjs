// FreeDV decoder — Node-side wrapper around David Rowe's `freedv_rx`
// from the codec2 repo.
//
// Unlike the text-output WSJT-X family, FreeDV's output is DECODED
// SPEECH AUDIO. Pipeline:
//
//   Kiwi 12 kHz int16 PCM
//      │   (3:2 decimator → 8 kHz, what freedv_rx expects)
//      ▼
//   freedv_rx <mode> - -          (stdin / stdout)
//      │
//      ▼  decoded 8 kHz int16 speech
//   WS  ──▶  client AudioBufferSourceNode chain  ──▶  speakers
//
// We forward decoded speech as plain binary frames over the WS so the
// client can chain it into the audio graph without parsing. Status
// messages (sync state, current SNR) come down as JSON, identical to
// the other batch decoders' shape.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'freedv', 'bin', 'freedv_rx');

const KIWI_RATE = 12_000;
const FREEDV_RATE = 8_000;
const VALID_MODES = new Set(['1600', '700C', '700D', '700E', '2020', '2020B']);

export class FreedvDecoder {
  /**
   * @param {object} opts
   * @param {string} [opts.mode='700D']  FreeDV mode.
   * @param {() => number} opts.dialFreqKHz
   * @param {(pcm: Buffer) => void} [opts.onAudio]   Decoded 8 kHz int16 LE speech.
   * @param {(msg: string) => void} [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.mode = VALID_MODES.has(opts.mode) ? opts.mode : '700D';
    this.proc = null;
    this.closed = false;
    // 3:2 decimator state — Kiwi 12 kHz → FreeDV 8 kHz. We take every
    // third sample after a 2-tap average; cheap pre-filter against
    // aliasing for the upper 2-4 kHz of the band.
    this.decimIdx = 0;
    this.decimPrev = 0;
    // Scratch buffer for the decimated PCM we hand to freedv_rx.
    this.decimScratch = new Int16Array(16384);
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('freedv_rx missing — run `npm run build:freedv`');
      return;
    }
    this.spawn();
  }

  spawn() {
    try {
      // freedv_rx <mode> <input.raw|-> <output.raw|->
      // STDIN / STDOUT for both, raw 16-bit signed little-endian PCM.
      this.proc = spawn(BIN, [this.mode, '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    this.proc.stdout.on('data', (chunk) => {
      // Decoded speech — forward as-is.
      this.opts.onAudio?.(chunk);
    });
    this.proc.stderr.setEncoding('utf8');
    // Tail of stderr so we can surface the last few lines if the
    // process exits unexpectedly (e.g. "invalid mode", missing
    // shared library, version mismatch). Without this the panel
    // just shows "freedv_rx exited code=1" and the real reason is
    // lost in stderr noise.
    this.stderrTail = [];
    // For the first 3 seconds after spawn, surface EVERY stderr
    // line as a status message so startup errors aren't filtered.
    // After that, switch to keyword-filtered output to keep the
    // panel readable during normal decode (which spams sync / SNR
    // every ~40 ms).
    this.spawnTs = Date.now();
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        this.stderrTail.push(t);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        const isStartup = (Date.now() - this.spawnTs) < 3000;
        if (isStartup) {
          this.opts.onStatus?.(`[stderr] ${t.slice(0, 160)}`);
        } else if (/FAIL|ERROR|invalid|usage|cannot|unknown/i.test(t)) {
          this.opts.onStatus?.(`[stderr] ${t.slice(0, 160)}`);
        } else if (/sync|SNR|nin|bits/i.test(t)) {
          this.opts.onStatus?.(t.slice(0, 120));
        }
      }
    });
    this.proc.on('exit', (code, sig) => {
      if (this.closed) { this.proc = null; return; }
      const tail = this.stderrTail.slice(-3).join(' | ');
      const reason = sig ? `signal=${sig}` : `code=${code}`;
      this.opts.onStatus?.(
        `freedv_rx exited (${reason})${tail ? ' — ' + tail.slice(0, 200) : ''}`
      );
      this.proc = null;
    });
    this.proc.on('error', (e) => {
      this.opts.onStatus?.(`freedv_rx error: ${e.message}`);
    });
    this.opts.onStatus?.(`spawned freedv_rx (${this.mode}) — waiting for sync`);
  }

  /** Pipe a chunk of Kiwi 12 kHz int16 LE PCM into freedv_rx. We
   *  decimate 12k → 8k inline (3:2 with a 2-tap average pre-filter)
   *  so the modem sees its expected rate without an external resampler. */
  feed(samples) {
    if (this.closed || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    const n = samples.length;
    if (this.decimScratch.length < Math.ceil((n * 2) / 3) + 4) {
      this.decimScratch = new Int16Array(Math.ceil((n * 2) / 3) + 4096);
    }
    const out = this.decimScratch;
    let w = 0;
    let idx = this.decimIdx;
    let prev = this.decimPrev;
    // 3-in / 2-out: emit samples 0 and 1 of each 3-sample window with
    // a (cur + prev) / 2 pre-filter; drop sample 2.
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const avg = ((s + prev) >> 1);
      prev = s;
      if (idx !== 2) out[w++] = avg;
      idx = (idx + 1) % 3;
    }
    this.decimIdx = idx;
    this.decimPrev = prev;
    try {
      this.proc.stdin.write(Buffer.from(out.buffer, out.byteOffset, w * 2));
    } catch {
      // pipe broke — let the exit handler clean up.
    }
  }

  setMode(mode) {
    if (!VALID_MODES.has(mode) || mode === this.mode) return;
    this.opts.onStatus?.(`switching to ${mode}…`);
    // freedv_rx is mode-pinned at startup, so we restart it.
    this.mode = mode;
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
    this.decimIdx = 0;
    this.decimPrev = 0;
    if (!this.closed) this.spawn();
  }

  close() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
  }
}

void KIWI_RATE; void FREEDV_RATE;
