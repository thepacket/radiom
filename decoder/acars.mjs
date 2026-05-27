// ACARS VHF decoder — f00b4r0/acarsdec, audio-in / JSON-out.
// 131 MHz airline data link (MSK 2400 bps inside a 25 kHz channel).
//
// Input plumbing notes:
// We can't feed acarsdec via stdin in RAW mode. libsndfile's sf_open
// fstat-checks the path for seekability; pipes (and /dev/stdin, and
// fifos in RAW format) come back unseekable → "could not open".
// Workaround: prepend a streaming WAV (RIFF) header to a fifo with the
// RIFF/data sizes set to 0xFFFFFFFF. libsndfile's WAV demuxer reads
// the header once and then streams the PCM payload without seeking
// back to patch the length, so the pipe restriction doesn't apply.
// Sample rate is set in the header (12 kHz mono int16); `-m` becomes
// implicit and we drop it.

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'acars', 'bin', 'acarsdec');

// 44-byte canonical PCM WAV header, sized for an open-ended stream.
function wavHeader({ sampleRate = 12000, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(0xFFFFFFFF, 4);          // RIFF size (streaming sentinel)
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);                 // fmt chunk size
  b.writeUInt16LE(1, 20);                  // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bitsPerSample, 34);
  b.write('data', 36);
  b.writeUInt32LE(0xFFFFFFFF, 40);         // data size (streaming sentinel)
  return b;
}

export class AcarsDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    this.fifoPath = path.join(tmpdir(), `radiom-acars-${process.pid}-${Date.now()}.fifo`);
    this.fifoFd = -1;
    this.headerWritten = false;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('acarsdec missing — run `npm run build:acars`');
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
      // --sndfile with bare `file=` lets libsndfile auto-detect the
      // container (WAV) from the header we'll write into the fifo.
      // --output is FORMAT:DEST:PARAMS — fileout.c special-cases
      // path=- to mean stdout.
      this.proc = spawn(BIN, [
        '--sndfile', `file=${this.fifoPath}`,
        '--output', 'oneline:file:path=-',
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
      // Mirror to server stderr so `fly logs` shows the SNDFILE error
      // path (the in-app status overlay only catches one line clipped
      // to 160 chars).
      process.stderr.write(`[acarsdec] ${text}\n`);
      for (const line of text.split('\n')) if (line.trim()) this.opts.onStatus?.(line.slice(0, 160));
    });
    this.proc.on('exit', (code) => {
      if (!this.closed) this.opts.onStatus?.(`acarsdec exited code=${code}`);
      this.proc = null;
    });
    this.proc.on('error', (e) => this.opts.onStatus?.(`acarsdec error: ${e.message}`));
    this.opts.onStatus?.('listening');
    // Open the fifo for writing AFTER spawning — open(O_WRONLY) blocks
    // until the reader (acarsdec) opens its end. Small delay so the
    // child has a moment to get there first.
    setTimeout(() => {
      try {
        this.fifoFd = openSync(this.fifoPath, 'w');
        // Write the RIFF header up front. libsndfile reads it once and
        // then streams the rest of the data chunk indefinitely.
        writeSync(this.fifoFd, wavHeader({ sampleRate: 12000, channels: 1 }));
        this.headerWritten = true;
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
      if (!line) continue;
      this.opts.onText?.(line);
      try {
        const j = JSON.parse(line);
        this.opts.onEvent?.({
          raw: line, tsMs: Date.now(),
          reg:    j.reg ?? j.aircraft?.tail ?? undefined,
          flight: j.flight ?? j.fid ?? undefined,
          label:  j.label ?? undefined,
          msg:    j.txt ?? j.message ?? undefined,
        });
      } catch { /* not JSON — already forwarded as raw text */ }
    }
  }

  feed(samples) {
    if (this.closed || !this.headerWritten || this.fifoFd < 0) return;
    if (samples.length === 0) return;
    try {
      writeSync(this.fifoFd,
        Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    } catch { /* EPIPE if reader exited */ }
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
