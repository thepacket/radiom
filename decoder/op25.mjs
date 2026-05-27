// OP25 — boatbod/op25's rx.py wrapped as a child process. Decodes
// P25 Phase 1 (CQPSK) and Phase 2 (FSK4) including control-channel
// trunking. Unlike dsd-fme (which decodes one channel of P25 at a
// time), OP25 follows the system across talkgroups.
//
// Plumbing notes:
// * rx.py expects a complex float32 IQ stream via `-F <path>`. The
//   bridge receives cs16 (int16 interleaved I+Q) from the OWRX /
//   rtl_tcp source and converts to cf32 on the fly.
// * `-F` opens the path with Python file IO and reads continuously,
//   so a named pipe (fifo) works — same pattern as acars/jaero/dsc.
// * rx.py refuses to run without `-l <terminal>`. We use
//   `-l http:127.0.0.1:<ephemeral>` so it serves its terminal on a
//   loopback HTTP port instead of taking over the tty with curses.
//   The port is picked at random so multiple OP25 sessions don't
//   collide (and so the :8000 default doesn't fight any other service).
// * Events / status land on stderr when `-v 1+` is set; we forward
//   matching lines to the client over the WS.
// * Audio output is via pyaudio by default — broken in fly's VM.
//   We don't need decoded voice, just metadata, so `-2` (audio-to-
//   UDP) is enabled with a black-hole port to suppress the audio
//   sink without making rx.py panic.

import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { existsSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// rx.py lives in the apps tree staged by the Dockerfile.
const RX_PY = '/usr/local/share/op25/apps/rx.py';

export class Op25Decoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stderrBuf = '';
    this.fifoPath = path.join(tmpdir(), `radiom-op25-${process.pid}-${Date.now()}.iq`);
    this.fifoFd = -1;
    // OP25 sample rate. Most RfProfiles in radiom feed cs16 IQ at
    // ~96 kHz or higher; 96000 matches the build wrapper's default
    // and is enough bandwidth for one P25 channel (12.5 kHz).
    this.sampleRate = Number(opts.sampleRate) || 96_000;
    this.demod = opts.demod === 'fsk4' ? 'fsk4' : 'cqpsk';
    if (!existsSync(RX_PY)) {
      this.opts.onStatus?.('op25 rx.py missing — run `npm run build:op25`');
      return;
    }
    try {
      execSync(`mkfifo ${this.fifoPath}`);
    } catch (e) {
      this.opts.onStatus?.(`mkfifo failed: ${e.message}`);
      return;
    }
    this.pickTerminalPort().then((port) => this.spawn(port));
  }

  /** Find a free loopback port for OP25's HTTP terminal. We can't
   *  hand it 0 because rx.py wants a fixed port; bind/release a TCP
   *  socket to grab one the kernel will reuse. */
  async pickTerminalPort() {
    return new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
    });
  }

  spawn(termPort) {
    const argv = [
      RX_PY,
      '-F', this.fifoPath,
      '-S', String(this.sampleRate),
      '-D', this.demod,
      '-l', `http:127.0.0.1:${termPort}`,
      '-v', '1',
      // -2: send decoded voice over UDP. Pin to a closed loopback
      // port so pyaudio isn't loaded at all (we have no audio
      // output device in the VM).
      '-2',
      '-U', '127.0.0.1:1',
    ];
    // Trace the spawn boundary into fly logs so a silent failure is
    // distinguishable from "ran fine, just no events". Previously the
    // only thing we wrote on error was a panel status, which doesn't
    // land in fly logs.
    process.stderr.write(`[op25] spawning: python3 ${argv.join(' ')}\n`);
    try {
      this.proc = spawn('python3', argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: '/usr/local/share/op25/apps',
      });
    } catch (e) {
      process.stderr.write(`[op25] spawn threw: ${e.message}\n`);
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    process.stderr.write(`[op25] spawned pid=${this.proc.pid}\n`);
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => {
      const text = c.toString().trimEnd();
      for (const line of text.split('\n')) if (line.trim()) this.opts.onText?.(line);
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => this.consumeStderr(c));
    this.proc.on('exit', (code, signal) => {
      if (!this.closed) {
        const detail = `code=${code}${signal ? ` sig=${signal}` : ''}`;
        this.opts.onStatus?.(`op25 exited ${detail}`);
        process.stderr.write(`[op25] exited ${detail}\n`);
      }
      this.proc = null;
    });
    this.proc.on('error', (e) => {
      process.stderr.write(`[op25] proc error: ${e.message}\n`);
      this.opts.onStatus?.(`op25 error: ${e.message}`);
    });
    this.opts.onStatus?.(`listening (term :${termPort}, ${this.demod} @ ${this.sampleRate} Hz)`);
    // Open the fifo for writing after spawn — rx.py's open() blocks
    // until our writer attaches. The 500 ms delay gives Python time
    // to import GR + reach the file-open in the flowgraph.
    setTimeout(() => {
      try { this.fifoFd = openSync(this.fifoPath, 'w'); }
      catch (e) { this.opts.onStatus?.(`fifo open (write) failed: ${e.message}`); }
    }, 500);
  }

  consumeStderr(chunk) {
    this.stderrBuf += chunk;
    let nl;
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, nl).trim();
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      if (!line) continue;
      // Mirror everything to fly logs for diagnostics.
      process.stderr.write(`[op25] ${line}\n`);
      // OP25 emits a LOT of low-level GR boot chatter — keep the
      // client panel signal-to-noise high by only surfacing lines
      // that look like protocol events.
      if (/^(?:NAC|TG[ID]?|SRC|talkgroup|encrypt|tuning|frequency|control|p25|rx)\b/i.test(line)) {
        this.opts.onText?.(line);
        const ev = this.parseLine(line);
        if (ev) this.opts.onEvent?.(ev);
      } else if (/error|fail|critical/i.test(line)) {
        this.opts.onStatus?.(line.slice(0, 200));
      }
    }
  }

  parseLine(line) {
    const ev = { raw: line, tsMs: Date.now() };
    let m;
    if ((m = line.match(/NAC\s*[:=]?\s*0x([0-9A-F]+)/i))) ev.nac = `0x${m[1]}`;
    if ((m = line.match(/\bTGID?\s*[:=]?\s*(\d+)/i)))      ev.tgid = m[1];
    if ((m = line.match(/\bSRC\s*[:=]?\s*(\d+)/i)))        ev.src = m[1];
    if ((m = line.match(/\b(?:tuning|frequency)\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*([kMG]?Hz)/i))) {
      ev.freq = `${m[1]} ${m[2]}`;
    }
    return Object.keys(ev).length > 2 ? ev : null;
  }

  /** Accepts cs16 IQ samples (interleaved I,Q int16). Converts to
   *  cf32 (interleaved I,Q float32 normalized to [-1, 1]) and pushes
   *  into the fifo. Skips when fifo isn't yet open. */
  feed(samples) {
    if (this.closed || this.fifoFd < 0) return;
    const n = samples.length;
    if (n === 0 || (n & 1)) return;            // need even count for IQ pairs
    // cf32: each sample becomes 4 bytes (float32). cs16 in is 2 bytes.
    const out = Buffer.allocUnsafe(n * 4);
    for (let i = 0; i < n; i++) {
      // 32767 normalization: int16 → [-1.0, 1.0] approx.
      out.writeFloatLE(samples[i] / 32768, i * 4);
    }
    try { writeSync(this.fifoFd, out); } catch { /* EPIPE on shutdown */ }
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
