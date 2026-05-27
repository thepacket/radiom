// AIS decoder — hessu/aisdecoder, audio-in / NMEA-over-UDP-out.
// Source audio: int16 LE 48 kHz (the only rate the gnuais demodulator
// supports — the bridge resamples 12 kHz → 48 kHz with the same
// linear-interp helper used by dsd / multimon.
//
// hessu/aisdecoder doesn't print NMEA on stdout — its output is UDP to
// a configured host:port (`-h <host> -p <port>`). We open a localhost
// UDP listener on an ephemeral port, hand that port to the child, and
// read decoded !AIVDM,...,*<chk> sentences off the socket.
//
// Audio input uses the `file` driver pointed at /dev/stdin, which
// works because aisdecoder's file driver just opens the path and
// fread()s int16 PCM — no seek/fstat (unlike libsndfile).
//
// Output to client:
//   - onText(): raw NMEA sentence
//   - onEvent({raw,tsMs,mmsi}): MMSI extracted from the 6-bit-armor
//     payload (first 30 data bits after type+repeat).

import { spawn, execSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { existsSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'ais', 'bin', 'aisdecoder');

const SRC_RATE = 12_000;
const AIS_RATE = 48_000;

export class AisDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.udpBuf = '';
    this.resamplePhase = 0;
    this.resamplePrev = 0;
    this.resampleScratch = new Int16Array(32768);
    this.udp = null;
    this.fifoPath = path.join(tmpdir(), `radiom-ais-${process.pid}-${Date.now()}.fifo`);
    this.fifoFd = -1;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('aisdecoder missing — run `npm run build:ais`');
      return;
    }
    // hessu/aisdecoder's file driver fopen()s the path. On Bookworm-
    // slim under Firecracker, /dev/stdin isn't always a populated
    // symlink, so fopen returns NULL → "Can't open raw file for read".
    // A real named pipe works: fopen blocks until the writer opens.
    try {
      execSync(`mkfifo ${this.fifoPath}`);
    } catch (e) {
      this.opts.onStatus?.(`mkfifo failed: ${e.message}`);
      return;
    }
    this.startUdp();
  }

  startUdp() {
    // Bind to an ephemeral port on loopback; the kernel picks the
    // number, then we pass it to aisdecoder via -p.
    this.udp = createSocket('udp4');
    this.udp.on('message', (buf) => this.consumeUdp(buf.toString('utf8')));
    this.udp.on('error', (e) => this.opts.onStatus?.(`udp error: ${e.message}`));
    this.udp.bind(0, '127.0.0.1', () => {
      const addr = this.udp.address();
      this.spawn(addr.port);
    });
  }

  spawn(port) {
    try {
      // -a file -f <fifo>    : read 48 kHz int16 PCM from a named pipe
      //                         (the file driver fopen()s — fopen on a
      //                         fifo blocks until the writer opens).
      // -c mono              : single-channel input (our bridge mixes
      //                         to mono before resampling).
      // -h 127.0.0.1 -p <p>  : ship NMEA back to our UDP listener.
      // -d                   : also log NMEA to stderr (handy for fly
      //                         logs when the UDP socket is silent).
      this.proc = spawn(BIN, [
        '-a', 'file', '-f', this.fifoPath,
        '-c', 'mono',
        '-h', '127.0.0.1', '-p', String(port),
        '-d',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => {
      // hessu/aisdecoder generally doesn't print on stdout; treat
      // anything that does show up as a status line.
      const text = c.toString().trimEnd();
      if (text.trim()) this.opts.onStatus?.(text.slice(0, 160));
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const text = c.toString().trimEnd();
      process.stderr.write(`[aisdecoder] ${text}\n`);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        // -d echoes NMEA on stderr; parse those too so the panel works
        // even if the loopback UDP packet is lost.
        if (line.startsWith('!AIV')) this.consumeNmea(line);
        else this.opts.onStatus?.(line.slice(0, 160));
      }
    });
    this.proc.on('exit', (code, signal) => {
      if (!this.closed) {
        const detail = `code=${code}${signal ? ` sig=${signal}` : ''}`;
        this.opts.onStatus?.(`aisdecoder exited ${detail}`);
        process.stderr.write(`[aisdecoder] exited ${detail}\n`);
      }
      this.proc = null;
    });
    this.proc.on('error', (e) => this.opts.onStatus?.(`aisdecoder error: ${e.message}`));
    this.opts.onStatus?.('listening');
    // Open the fifo for writing AFTER the child is alive — fopen on
    // the reader side will be waiting; openSync('w') unblocks it.
    setTimeout(() => {
      try {
        this.fifoFd = openSync(this.fifoPath, 'w');
      } catch (e) {
        this.opts.onStatus?.(`fifo open (write) failed: ${e.message}`);
      }
    }, 300);
  }

  consumeUdp(chunk) {
    // UDP frames may carry one or multiple NMEA sentences separated by
    // CR/LF; split conservatively.
    this.udpBuf += chunk;
    let nl;
    while ((nl = this.udpBuf.search(/[\r\n]/)) >= 0) {
      const line = this.udpBuf.slice(0, nl).trim();
      this.udpBuf = this.udpBuf.slice(nl + 1);
      if (line) this.consumeNmea(line);
    }
  }

  consumeNmea(line) {
    this.opts.onText?.(line);
    // !AIVDM,1,1,,A,<payload>,<fillbits>*<chk>
    const m = line.match(/^!AIV[DT]M,\d+,\d+,[^,]*,[AB],([^,]+),\d/);
    if (m) {
      const mmsi = decodeMmsi(m[1]);
      this.opts.onEvent?.({ raw: line, tsMs: Date.now(), mmsi });
    }
  }

  feed(samples) {
    if (this.closed || this.fifoFd < 0) return;
    const n = samples.length;
    if (n === 0) return;
    const need = n * 4 + 8;     // 12k → 48k = 4× upsample
    if (this.resampleScratch.length < need) this.resampleScratch = new Int16Array(need);
    const out = this.resampleScratch;
    let w = 0;
    const ratio = SRC_RATE / AIS_RATE;
    let phase = this.resamplePhase, prev = this.resamplePrev;
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
    try { writeSync(this.fifoFd, Buffer.from(out.buffer, out.byteOffset, w * 2)); } catch { /* EPIPE */ }
  }

  close() {
    this.closed = true;
    try { if (this.fifoFd >= 0) closeSync(this.fifoFd); } catch {}
    this.fifoFd = -1;
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
    try { this.udp?.close(); } catch {}
    this.udp = null;
    try { unlinkSync(this.fifoPath); } catch {}
  }
}

/** Decode the first 30 bits (MMSI field) of an AIS payload. AIS uses
 *  a 6-bit-per-char ASCII armor: subtract 48, if >40 then -8, gives
 *  0..63 → 6-bit value. */
function decodeMmsi(payload) {
  // Skip the 6-bit message type, then read 2 bits repeat + 30 bits MMSI.
  let bits = '';
  for (let i = 0; i < Math.min(7, payload.length); i++) {
    let v = payload.charCodeAt(i) - 48;
    if (v > 40) v -= 8;
    if (v < 0 || v > 63) return undefined;
    bits += v.toString(2).padStart(6, '0');
  }
  if (bits.length < 38) return undefined;
  const mmsi = parseInt(bits.slice(8, 38), 2);
  return Number.isFinite(mmsi) ? String(mmsi) : undefined;
}
