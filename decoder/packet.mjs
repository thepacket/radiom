// AX.25 / APRS packet decoder — Node-side child-process wrapper around
// direwolf. Three baud rates + an IL2P framing variant, four configs:
//
//   baud=300                    → direwolf.conf        (HF AX.25)
//   baud=1200                   → direwolf-vhf.conf    (VHF Bell-202, APRS)
//   baud=9600                   → direwolf-9600.conf   (G3RUH, FOX cubesats)
//   baud=1200 + framing='il2p'  → direwolf-il2p.conf   (Nino Carrillo's
//                                                       FEC framing on
//                                                       VHF 1200; works
//                                                       through QRM/QSB
//                                                       that breaks AX.25)
//
// HF + VHF configs use 12 kHz audio (matches the radiom pipeline).
// 9600 G3RUH needs ≥24 kHz Nyquist for its ~9.6 kHz baseband; the
// bridge upsamples 12 kHz → 48 kHz with linear interp before piping
// into a 48 kHz-ARATE direwolf. Note that interpolation can't add
// signal bandwidth the source didn't carry — Kiwi audio (≤6 kHz)
// will produce no 9600 decodes regardless. Wideband NBFM sources
// (rtl_tcp / OWRX) are required.
//
// Direwolf prints decoded frames to stdout as plain text; we forward
// only the lines that look like a real frame ("Fm CALL To CALL …" or
// "[N] CALL>DEST,WIDE2-2:") and skip its startup chatter.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN  = path.resolve(__dirname, '..', 'decoders', 'packet', 'bin', 'direwolf');
const CONF_HF   = path.resolve(__dirname, '..', 'decoders', 'packet', 'direwolf.conf');
const CONF_VHF  = path.resolve(__dirname, '..', 'decoders', 'packet', 'direwolf-vhf.conf');
const CONF_9600 = path.resolve(__dirname, '..', 'decoders', 'packet', 'direwolf-9600.conf');
const CONF_IL2P = path.resolve(__dirname, '..', 'decoders', 'packet', 'direwolf-il2p.conf');

const SRC_RATE  = 12_000;
const G3RUH_RATE = 48_000;

export class PacketDecoder {
  /**
   * @param {object} opts
   * @param {(line: string) => void} [opts.onLine]   Each forwarded text line.
   * @param {(msg: string) => void}  [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.stdoutBuf = '';
    // Pick baud: 1200 → VHF Bell-202; 9600 → G3RUH; default 300 HF.
    this.baud = (opts.baud === 1200 || opts.baud === 9600) ? opts.baud : 300;
    // Framing layer on top of the carrier. 'il2p' is only meaningful
    // for baud=1200 today (the IL2P config pins 1200); other bauds
    // fall back to plain AX.25.
    this.framing = opts.framing === 'il2p' ? 'il2p' : 'ax25';
    // 9600 G3RUH needs 12 kHz → 48 kHz upsampling.
    this._resamplePhase = 0;
    this._resamplePrev = 0;
    this._resampleScratch = new Int16Array(32768);
    this._spawn();
  }

  feed(/** @type {Int16Array} */ samples) {
    if (!this.proc || this.proc.exitCode != null) return;
    if (this.baud === 9600) {
      // 12 kHz → 48 kHz linear interpolation (same shape as sonde /
      // cospas bridges). Interpolation extends the rate but can't
      // add bandwidth — if the source audio is band-limited at
      // 6 kHz (Kiwi), the upper half of the 48 kHz spectrum is
      // empty and 9600 G3RUH won't decode.
      const n = samples.length;
      if (n === 0) return;
      const need = n * 4 + 8;
      if (this._resampleScratch.length < need) this._resampleScratch = new Int16Array(need);
      const out = this._resampleScratch;
      let w = 0, phase = this._resamplePhase, prev = this._resamplePrev;
      const ratio = SRC_RATE / G3RUH_RATE;
      for (let i = 0; i < n; i++) {
        const cur = samples[i];
        while (phase < 1) {
          const y = prev + (cur - prev) * phase;
          out[w++] = Math.max(-32768, Math.min(32767, y | 0));
          phase += ratio;
        }
        phase -= 1; prev = cur;
      }
      this._resamplePhase = phase; this._resamplePrev = prev;
      try { this.proc.stdin.write(Buffer.from(out.buffer, out.byteOffset, w * 2)); } catch {}
      return;
    }
    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    this.proc.stdin.write(buf);
  }

  close() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill('SIGTERM'); } catch {}
    this.proc = null;
  }

  _spawn() {
    let proc;
    const conf = this.framing === 'il2p' ? CONF_IL2P
               : this.baud === 9600       ? CONF_9600
               : this.baud === 1200       ? CONF_VHF
               :                            CONF_HF;
    // direwolf has no IL2PRX config directive — IL2P RX is on by
    // default since 1.6 on any IL2P-compiled channel. To make the
    // ILP button visibly distinct from VPKT (same Bell-202 carrier),
    // pass `-d 2` which enables IL2P-specific debug output so each
    // IL2P-decoded frame is annotated in the panel.
    const extraArgs = this.framing === 'il2p' ? ['-d', '2'] : [];
    // direwolf does a stat() on the TX audio output path BEFORE
    // opening it for write — non-existent file → ENOENT → "Pointless
    // to continue without audio device". Touch the WAV path so the
    // stat succeeds; direwolf then opens it for write via libsndfile,
    // writes a 44-byte RIFF header on startup, and never grows it
    // (we never trigger TX). Shared across all four packet modes.
    try { closeSync(openSync('/tmp/direwolf-tx.wav', 'a')); } catch {}
    try {
      // -t 0 disables ANSI colour codes (would otherwise clutter stdout).
      // -q dh suppresses the per-frame APRS Description and Heard-line
      //       summaries — we only want the frame headers + payload bodies.
      proc = spawn(BIN, ['-c', conf, '-t', '0', '-q', 'dh', ...extraArgs, '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      console.error('[packet-decoder] spawn failed:', e.message, 'BIN=', BIN);
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    proc.stderr.on('data', (chunk) => {
      console.error('[packet-decoder]', chunk.toString().trimEnd());
    });
    proc.on('exit', (code, sig) => {
      console.error(`[packet-decoder] exit code=${code} sig=${sig ?? '-'}`);
      this.opts.onStatus?.(`decoder exited code=${code} sig=${sig ?? '-'}`);
      this.proc = null;
    });
    proc.on('error', (err) => {
      console.error('[packet-decoder] error:', err.message, 'BIN=', BIN);
      this.opts.onStatus?.(`decoder error: ${err.message}`);
    });
  }

  _onStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trimEnd();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      if (this._shouldForward(line)) this.opts.onLine?.(line);
    }
  }

  /** Whitelist of meaningful direwolf output. The previous allow-list
   *  (frame headers only) was too restrictive — it dropped every
   *  *parsed* APRS line direwolf emits after a header:
   *    - "Telemetry data, Seq=N: Battery=12.4V Temp=20.5C …"
   *    - "Position: 45.5000N 73.5000W  alt 250m"
   *    - "Weather: Wind 5mph 270°, Rain 0.0in, Temp 22C"
   *    - "Status: …", "Message to …", "Object: …", "Item: …"
   *    - "PARM.", "UNIT.", "EQNS.", "BITS." (telemetry metadata)
   *    - "T#nnn,…" raw telemetry payload
   *
   *  Switch to a deny-list of direwolf banner/diagnostic patterns and
   *  forward everything else. False positives are visually obvious in
   *  the panel; false negatives lose decoded data silently. */
  _shouldForward(line) {
    // Banner / startup chatter — drop.
    if (/^Dire Wolf|^Reading symbols/.test(line)) return false;
    if (/^Audio (input|output|sample) /.test(line)) return false;
    if (/^Could not open|^Failed to/.test(line)) return false;
    if (/^Listening on |^Ready to accept/.test(line)) return false;
    if (/^Including .* in beacon|^Beacon/.test(line)) return false;
    if (/^TNC (started|init|version)/i.test(line)) return false;
    if (/^Modem channel /.test(line)) return false;
    if (/^channel \d+: /i.test(line)) return false;
    if (/^Try -h for help|^Usage:/.test(line)) return false;
    if (/^IL2P (encoded|decoded) frame/.test(line)) {
      // Direwolf prints IL2P frame announcements; keep them.
      return true;
    }
    if (/^DCD ch=|^Sample rate /.test(line)) return false;
    // Everything else: forward. Includes frame headers, payload
    // bodies, parsed APRS interpretations, and telemetry breakdowns.
    return true;
  }
}
