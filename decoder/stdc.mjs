// Inmarsat STD-C — SOLAS-mandated maritime safety messaging on L-band
// (1525–1559 MHz). NCS Common Channels carry station lists, EGC
// broadcasts (weather, NAV warnings, GMDSS distress relays); LES TDM
// channels carry directed ship-shore messages.
//
// Decoder: alphafox02/inmarsat-sniffer — the same binary we vendored
// for JAERO (Aero Classic), invoked here with `--mode=stdc` instead
// of `--mode=aero`. Upstream description: "STD-C EGC + Aero …".
//
// Plumbing matches the jaero bridge: cs16 IQ in via a fifo, decoder
// reads from -f, writes decoded telegrams to stdout. Source must be
// rtl_tcp or OWRX at L-band (≥1 Ms/s recommended).
//
// Previously this file invoked sigsegv-mvm/scytale-c, but that repo
// 404s on GitHub. Reusing the inmarsat-sniffer build means zero new
// binary, zero new Dockerfile stage.

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Reuse the inmarsat-sniffer binary installed by the jaero-build stage.
// Symlinked as decoders/jaero/bin/jaero-cli (we keep both decoders
// pointing at the same .so so the runtime image carries one copy).
const BIN = path.resolve(__dirname, '..', 'decoders', 'jaero', 'bin', 'jaero-cli');

export class StdcDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    this.fifoPath = path.join(tmpdir(), `radiom-stdc-${process.pid}-${Date.now()}.fifo`);
    this.fifoFd = -1;
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('inmarsat-sniffer missing — run `npm run build:jaero`');
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
    // Default satellite picks Inmarsat I-4 F3 (Atlantic Ocean Region
    // West, ~98°W) — most relevant for Americas operations. Override
    // via STDC_SATELLITE / JAERO_SATELLITE env: 3F5=AOR-E, AF1=IOR, F1=POR.
    const sat = process.env.STDC_SATELLITE || process.env.JAERO_SATELLITE || '4F3';
    const argv = [
      '-f', this.fifoPath,
      '--format=cs16',
      '--mode=stdc',
      `--satellite=${sat}`,
    ];
    process.stderr.write(`[stdc] spawning: ${BIN} ${argv.join(' ')}\n`);
    try {
      this.proc = spawn(BIN, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      process.stderr.write(`[stdc] spawn threw: ${e.message}\n`);
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    process.stderr.write(`[stdc] spawned pid=${this.proc.pid}\n`);
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this.consumeStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const text = c.toString().trimEnd();
      process.stderr.write(`[stdc] ${text}\n`);
      for (const line of text.split('\n'))
        if (line.trim()) this.opts.onStatus?.(line.slice(0, 200));
    });
    this.proc.on('exit', (code, signal) => {
      if (!this.closed) {
        const detail = `code=${code}${signal ? ` sig=${signal}` : ''}`;
        this.opts.onStatus?.(`inmarsat-sniffer exited ${detail}`);
        process.stderr.write(`[stdc] exited ${detail}\n`);
      }
      this.proc = null;
    });
    this.proc.on('error', (e) => {
      process.stderr.write(`[stdc] proc error: ${e.message}\n`);
      this.opts.onStatus?.(`inmarsat-sniffer error: ${e.message}`);
    });
    this.opts.onStatus?.('listening (Inmarsat STD-C via inmarsat-sniffer)');
    // Open the fifo writer after spawn — fopen blocks until the
    // reader (the child's -f flag) opens its end. 300 ms is plenty
    // for the child to reach that point.
    setTimeout(() => {
      try {
        this.fifoFd = openSync(this.fifoPath, 'w');
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
      if (line) this.opts.onText?.(line);
    }
  }

  /** Pass cs16 IQ bytes verbatim into the fifo. The shell sets the
   *  rtl_tcp / OWRX output format to int16 via the RfProfile for
   *  btnStdc. */
  feed(buf) {
    if (this.closed || this.fifoFd < 0) return;
    try { writeSync(this.fifoFd, buf); } catch { /* EPIPE on shutdown */ }
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
