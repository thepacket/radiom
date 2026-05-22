// HF AX.25 / APRS packet decoder — Node-side child-process wrapper.
//
// Spawns direwolf with the bundled decoders/packet/direwolf.conf, which
// reads raw 12 kHz int16 mono PCM from stdin and decodes 300-baud HF
// packet (the `MODEM 300` line in the conf). Direwolf prints decoded
// frames to stdout as plain text, which we forward to the WS client.
//
// We strip direwolf's startup banner and most diagnostic chatter; only
// lines that look like a decoded frame ("Fm CALL To CALL …") or the
// indented payload that follows them reach the client.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN  = path.resolve(__dirname, '..', 'decoders', 'packet', 'bin', 'direwolf');
const CONF = path.resolve(__dirname, '..', 'decoders', 'packet', 'direwolf.conf');

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
    this._spawn();
  }

  feed(/** @type {Int16Array} */ samples) {
    if (!this.proc || this.proc.exitCode != null) return;
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
    try {
      // -t 0 disables ANSI colour codes (would otherwise clutter stdout).
      // -q dh suppresses the per-frame APRS Description and Heard-line
      //       summaries — we only want the frame headers + payload bodies.
      proc = spawn(BIN, ['-c', CONF, '-t', '0', '-q', 'dh', '-'], {
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
      // Filter direwolf's startup/banner/diagnostic noise — only forward
      // lines that look like a decoded AX.25 frame header or its payload.
      if (this._isDecodedLine(line)) this.opts.onLine?.(line);
    }
  }

  _isDecodedLine(line) {
    // Decoded frame header: "[0] N0CALL>APRS,WIDE2-2:" or "Fm N0CALL To APRS …".
    // Payload bodies are everything that doesn't look like a banner /
    // config readout / port message.
    if (/^\[\d+(\.\d+)?\]/.test(line)) return true;
    if (/^[A-Z0-9-]+>[A-Z0-9-]+/.test(line)) return true;
    if (/^Fm \S+ To \S+/.test(line)) return true;
    return false;
  }
}
