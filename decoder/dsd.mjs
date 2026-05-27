// DSD (Digital Speech Decoder) — Node-side wrapper around `dsd-fme`,
// the lwvmobile (Florida Man Edition) fork.
//
// IMPORTANT: dsd-fme does NOT have a stdin audio input mode. Per the
// project's Install_Notes (audio_work branch), the documented input
// methods are:
//
//   -i <file.wav>   — read a WAV file (one-shot, not streaming)
//   -i tcp          — connect as a TCP client to a remote audio server
//                     speaking the OP25 audio-bin protocol (int16 LE
//                     stereo @ 48 kHz). dsd-fme connects to
//                     localhost:7355 by default; remote host/port
//                     overridable with -U <host> -p <port>.
//
// We use the TCP mode. The bridge opens a localhost TCP listener;
// dsd-fme is spawned with `-i tcp -U 127.0.0.1 -p <port>` so it
// connects in as a client. We then write source PCM into that socket.
// Decoded voice arrives on dsd-fme's `-w stdout` path; text events
// on stderr.
//
// Mode flags verified against dsd-fme audio_work usage docs:
//
//   D-STAR DV         mode='dstar'   →  -fd
//   DMR / MOTOTRBO     mode='dmr'     →  -ft        (Tier 2)
//   DMR Stereo         mode='dmrs'    →  -fs        (TDMA both slots)
//   NXDN 48 / 96       mode='nxdn'    →  -fn (4800) or -fN (9600)
//   YSF / C4FM         mode='ysf'     →  -fy
//   dPMR               mode='dpmr'    →  -fz
//   M17                mode='m17'     →  -fU
//   P25 Phase 1        mode='p25p1'   →  -fp
//   P25 Phase 2        mode='p25p2'   →  -f2
//   X2-TDMA            mode='x2tdma'  →  -fx
//   Auto-detect        mode='auto'    →  -fa

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'dsd', 'bin', 'dsd-fme');

const SRC_RATE = 12_000;
const DSD_RATE = 48_000;            // dsd-fme TCP audio is int16 LE
                                    // stereo @ 48 kHz (OP25 bin format)

/** mode → CLI flag list */
const MODE_FLAGS = {
  dstar:  ['-fd'],
  dmr:    ['-ft'],
  dmrs:   ['-fs'],
  nxdn48: ['-fn'],
  nxdn96: ['-fN'],
  ysf:    ['-fy'],
  dpmr:   ['-fz'],
  m17:    ['-fU'],
  p25p1:  ['-fp'],
  p25p2:  ['-f2'],
  x2tdma: ['-fx'],
  auto:   ['-fa'],
};

export class DsdDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.mode = (opts.mode in MODE_FLAGS) ? opts.mode : 'dmr';
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    // 12 kHz → 48 kHz linear resampler state.
    this.resamplePhase = 0;
    this.resamplePrev = 0;
    this.resampleScratch = new Int16Array(32768);
    // TCP plumbing.
    this.tcpServer = null;
    this.tcpClient = null;
    this.tcpPaused = false;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('dsd-fme missing — run `npm run build:dsd`');
      return;
    }
    this.start();
  }

  /** Open a localhost TCP listener, spawn dsd-fme with -i tcp pointed
   *  at that port. When dsd-fme connects we cache the socket; feed()
   *  resamples to 48 kHz stereo and writes to it. */
  start() {
    this.tcpServer = createServer((sock) => {
      // First (and only) client is dsd-fme.
      this.tcpClient = sock;
      sock.on('drain', () => { this.tcpPaused = false; });
      sock.on('error', () => { /* swallow EPIPE on shutdown */ });
      sock.on('close', () => { if (this.tcpClient === sock) this.tcpClient = null; });
      this.opts.onStatus?.('dsd-fme TCP client connected');
    });
    this.tcpServer.listen(0, '127.0.0.1', () => {
      const port = this.tcpServer.address().port;
      this.spawn(port);
    });
    this.tcpServer.on('error', (e) => this.opts.onStatus?.(`tcp listen failed: ${e.message}`));
  }

  spawn(port) {
    const flags = MODE_FLAGS[this.mode];
    try {
      // dsd-fme CLI gotchas (verified against dsd_main.c on the
      // audio_work branch):
      //   -i tcp:HOST:PORT  → audio input from a TCP server we expose
      //                        on 127.0.0.1:<port>. `-i tcp` alone
      //                        defaults to localhost:7355; there's no
      //                        separate -p flag for the audio socket.
      //   -o -              → write decoded voice to stdout (special-
      //                        cased in dsd_main.c:3406, audio_out_type=1).
      //   -N                → no ncurses UI (clean stderr text).
      //   -f<mode>          → protocol selector.
      //
      // What NOT to do (we had these wrong before):
      //   -U <port>         → RIGCTL TCP port (unrelated to audio
      //                        input). "-U 127.0.0.1" parsed as a
      //                        port → RIGCTL Connection Failure, and
      //                        the audio TCP defaulted to :7355.
      //   -w -              → -w is a WAV FILE path; there's no
      //                        stdout special-case → "Error - could
      //                        not open wav output file -".
      //
      // fly's VM has no PulseAudio → default `audio_out_dev = pulse`
      // would print an error. `-o -` sidesteps that AND gives us the
      // decoded voice on the bridge's proc.stdout (which the existing
      // onAudio callback already forwards).
      this.proc = spawn(BIN, [
        '-i', `tcp:127.0.0.1:${port}`,
        '-o', '-',
        '-N',
        ...flags,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    // stdout = decoded voice (8 kHz int16 LE mono from -w -).
    this.proc.stdout.on('data', (chunk) => {
      this.opts.onAudio?.(chunk);
    });
    // stderr = text events.
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => this.consumeStderr(c));
    this.proc.on('exit', (code) => {
      if (!this.closed) this.opts.onStatus?.(`dsd-fme exited code=${code}`);
      this.proc = null;
    });
    this.proc.on('error', (e) => this.opts.onStatus?.(`dsd-fme error: ${e.message}`));
    this.opts.onStatus?.(`listening (${this.mode.toUpperCase()}, TCP port ${port})`);
  }

  consumeStderr(chunk) {
    this.stderrBuf += chunk;
    let nl;
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, nl).trim();
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      if (!line) continue;
      // Skip banner / config lines so the client panel doesn't fill up.
      if (/^(version|reading|opening|writing|using|input|output|searching|loading)/i.test(line)) {
        this.opts.onStatus?.(line.slice(0, 160));
        continue;
      }
      this.opts.onText?.(line);
      const ev = this.parseLine(line);
      if (ev) this.opts.onEvent?.(ev);
    }
  }

  parseLine(line) {
    const ev = { mode: this.mode, raw: line, tsMs: Date.now() };
    let m;
    if ((m = line.match(/\bSRC\s*=?\s*(\d+|[0-9A-Z]+)/i))) ev.src = m[1];
    if ((m = line.match(/\b(?:DST|TG|TGID)\s*=?\s*(\d+|[0-9A-Z]+)/i))) ev.dst = m[1];
    if ((m = line.match(/\bNAC\s*=?\s*(0x[0-9A-F]+|\d+)/i))) ev.nac = m[1];
    if ((m = line.match(/\bCC\s*=?\s*(\d+)/i))) ev.cc = m[1];
    if ((m = line.match(/\bRAN\s*=?\s*(\d+)/i))) ev.ran = m[1];
    if ((m = line.match(/\bSlot\s*(\d)/i))) ev.slot = +m[1];
    if ((m = line.match(/\bSync[:=]\s*([+\-]?\S+)/i))) ev.sync = m[1];
    if ((m = line.match(/\bmycall\s*=\s*(\S+)/i))) ev.src = m[1];
    if ((m = line.match(/\burcall\s*=\s*(\S+)/i))) ev.dst = m[1];
    return Object.keys(ev).length > 3 ? ev : null;
  }

  /** Resample 12 kHz mono int16 → 48 kHz stereo int16 (duplicate L=R
   *  since dsd-fme expects OP25 bin stereo) and write into the TCP
   *  socket connected by dsd-fme. */
  feed(samples) {
    if (this.closed) return;
    const sock = this.tcpClient;
    if (!sock || sock.destroyed) return;          // dsd-fme not connected yet
    if (this.tcpPaused) return;                    // honour backpressure
    const n = samples.length;
    if (n === 0) return;
    // 12 → 48 kHz = 4× upsample. Stereo doubles byte rate again.
    const need = n * 4 * 2 + 8;                    // 2 channels × int16
    if (this.resampleScratch.length < need / 2) this.resampleScratch = new Int16Array(need / 2);
    const stereo = Buffer.allocUnsafe(need);
    let w = 0;
    const ratio = SRC_RATE / DSD_RATE;
    let phase = this.resamplePhase, prev = this.resamplePrev;
    for (let i = 0; i < n; i++) {
      const cur = samples[i];
      while (phase < 1) {
        const y = prev + (cur - prev) * phase;
        const s = Math.max(-32768, Math.min(32767, y | 0));
        // L = R = mono sample (OP25 bin stereo format).
        stereo.writeInt16LE(s, w); w += 2;
        stereo.writeInt16LE(s, w); w += 2;
        phase += ratio;
      }
      phase -= 1; prev = cur;
    }
    this.resamplePhase = phase; this.resamplePrev = prev;
    try {
      const ok = sock.write(stereo.subarray(0, w));
      if (!ok) this.tcpPaused = true;
    } catch { /* socket closed */ }
  }

  close() {
    this.closed = true;
    try { this.proc?.kill('SIGTERM'); } catch {}
    try { this.tcpClient?.destroy(); } catch {}
    try { this.tcpServer?.close(); } catch {}
    this.proc = null;
    this.tcpClient = null;
    this.tcpServer = null;
  }
}
