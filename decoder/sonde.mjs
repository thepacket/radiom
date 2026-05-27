// Radiosonde decoder — rs1729/RS family. Defaults to rs41mod
// (Vaisala RS41, ~70% of global launches as of 2026).
//
// rs1729 binaries read PCM via:
//   • WAV file on stdin (header auto-detected): sample rate, channels,
//     bit depth all read from the RIFF header.
//   • `- <rate> <bits>` flags: raw PCM stdin, but channels is
//     HARDCODED to 2 in the source — we'd need to duplicate every
//     sample. Cleaner to prepend a WAV header instead, which lets
//     us run mono.
//
// We send a streaming WAV (RIFF + sentinel sizes) like acars/ais:
// libsndfile-style auto-detection reads the header once, then
// streams the data chunk indefinitely.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.resolve(__dirname, '..', 'decoders', 'sonde', 'bin');

const SRC_RATE = 12_000;
const SND_RATE = 48_000;        // rs41mod prefers ≥ 24 kHz; 48 kHz
                                // matches the dump1090/rtl_ais convention

/** Sub-mode → binary name in decoders/sonde/bin/ */
const SONDE_BINS = {
  rs41:  'rs41mod',
  dfm09: 'dfm09mod',
  m10:   'm10mod',
  imet54: 'imet54mod',
  lms6:   'lms6Xmod',
  mp3h1:  'mp3h1mod',
};

function wavHeader({ sampleRate = SND_RATE, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(0xFFFFFFFF, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);             // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bitsPerSample, 34);
  b.write('data', 36);
  b.writeUInt32LE(0xFFFFFFFF, 40);
  return b;
}

export class SondeDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.subMode = (opts.subMode in SONDE_BINS) ? opts.subMode : 'rs41';
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    this.headerWritten = false;
    this.resamplePhase = 0;
    this.resamplePrev = 0;
    this.resampleScratch = new Int16Array(32768);
    const bin = path.join(BIN_DIR, SONDE_BINS[this.subMode]);
    if (!existsSync(bin)) {
      this.opts.onStatus?.(`${SONDE_BINS[this.subMode]} missing — run \`npm run build:sonde\``);
      return;
    }
    this.spawn(bin);
  }

  spawn(bin) {
    // Defaults are sensible per rs1729's README: --ecc + --ptu + --crc
    // gets you full GPS + telemetry with error correction. --json
    // structures the output as one JSON object per frame.
    const argv = ['--ecc', '--ptu', '--json'];
    process.stderr.write(`[${this.subMode}] spawning: ${bin} ${argv.join(' ')}\n`);
    try {
      this.proc = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      process.stderr.write(`[${this.subMode}] spawn threw: ${e.message}\n`);
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    process.stderr.write(`[${this.subMode}] spawned pid=${this.proc.pid}\n`);
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const text = c.toString().trimEnd();
      process.stderr.write(`[${this.subMode}] ${text}\n`);
      for (const line of text.split('\n')) if (line.trim()) this.opts.onStatus?.(line.slice(0, 160));
    });
    this.proc.on('exit', (code, signal) => {
      if (!this.closed) {
        const detail = `code=${code}${signal ? ` sig=${signal}` : ''}`;
        this.opts.onStatus?.(`sonde decoder exited ${detail}`);
        process.stderr.write(`[${this.subMode}] exited ${detail}\n`);
      }
      this.proc = null;
    });
    this.proc.on('error', (e) => {
      process.stderr.write(`[${this.subMode}] proc error: ${e.message}\n`);
      this.opts.onStatus?.(`sonde error: ${e.message}`);
    });
    // Pre-pend a streaming WAV header so the decoder's WAV demuxer
    // picks up 48 kHz mono int16 from the bytes that follow. Same
    // sentinel-size trick we use for acars (RIFF/data both 0xFFFFFFFF).
    try {
      this.proc.stdin.write(wavHeader({ sampleRate: SND_RATE, channels: 1 }));
      this.headerWritten = true;
    } catch (e) {
      this.opts.onStatus?.(`header write failed: ${e.message}`);
    }
    this.opts.onStatus?.(`listening (${this.subMode.toUpperCase()})`);
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
    if (!this.headerWritten) return;
    const n = samples.length;
    if (n === 0) return;
    // 12 kHz → 48 kHz linear interp.
    const need = n * 4 + 8;
    if (this.resampleScratch.length < need) this.resampleScratch = new Int16Array(need);
    const out = this.resampleScratch;
    let w = 0, phase = this.resamplePhase, prev = this.resamplePrev;
    const ratio = SRC_RATE / SND_RATE;
    for (let i = 0; i < n; i++) {
      const cur = samples[i];
      while (phase < 1) {
        const y = prev + (cur - prev) * phase;
        out[w++] = Math.max(-32768, Math.min(32767, y | 0));
        phase += ratio;
      }
      phase -= 1; prev = cur;
    }
    this.resamplePhase = phase; this.resamplePrev = prev;
    try { this.proc.stdin.write(Buffer.from(out.buffer, out.byteOffset, w * 2)); } catch {}
  }

  close() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
  }
}
