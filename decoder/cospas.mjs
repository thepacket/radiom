// COSPAS-SARSAT 406 MHz beacon decoder — wraps jbirby/COSPAS-SARSAT-
// 406-MHz-Beacon-Codec (MIT, Python+numpy). Decodes 1G (Biphase-L
// 400 baud, C/S T.001) and 2G (OQPSK DSSS 300 baud, C/S T.018) ELT /
// EPIRB / PLB distress messages on 406.025 / 406.028 / 406.037 MHz.
//
// Plumbing follows the DSC bridge:
// rolling 12 kHz int16 mono ring buffer → periodic snapshot to WAV →
// `python3 cs406.py <wav>` → parse stdout → emit. Beacons transmit
// ~520 ms bursts every ~50 s when activated, so the window must be
// ≥1 s and the cadence should be well under 50 s. Chosen: 30 s
// window, decode every 10 s (overlap catches a burst even when it
// straddles the slice).

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.resolve(__dirname, '..', 'decoders', 'cospas', 'bin');
const DECODER = path.join(SCRIPT_DIR, 'cs406.py');

const SAMPLE_RATE   = 12_000;
const WINDOW_SEC    = 30;
const DECODE_EVERY  = 10_000;
const WINDOW_BYTES  = SAMPLE_RATE * WINDOW_SEC * 2;

function wavHeader(dataLen) {
  const byteRate = SAMPLE_RATE * 2;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);          // PCM
  b.writeUInt16LE(1, 22);          // mono
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

export class CospasDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.closed = false;
    this.tmpDir = mkdtempSync(path.join(tmpdir(), 'radiom-cospas-'));
    this.ring = Buffer.alloc(WINDOW_BYTES);
    this.ringWritePos = 0;
    this.ringFull = false;
    this.lastEmitted = '';
    if (!existsSync(DECODER)) {
      this.opts.onStatus?.('cs406 decoder missing — run `npm run build:cospas`');
      return;
    }
    const probe = spawnSync('python3', ['-c', 'import numpy'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      this.opts.onStatus?.('python3 / numpy missing in runtime');
      return;
    }
    this.opts.onStatus?.('listening (Cospas-Sarsat 406 MHz)');
    this.timer = setInterval(() => this.maybeDecode(), DECODE_EVERY);
  }

  feed(samples) {
    if (this.closed) return;
    const n = samples.length;
    if (n === 0) return;
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, n * 2);
    let off = 0;
    while (off < bytes.length) {
      const space = WINDOW_BYTES - this.ringWritePos;
      const chunk = Math.min(space, bytes.length - off);
      bytes.copy(this.ring, this.ringWritePos, off, off + chunk);
      this.ringWritePos += chunk;
      off += chunk;
      if (this.ringWritePos >= WINDOW_BYTES) {
        this.ringWritePos = 0;
        this.ringFull = true;
      }
    }
  }

  snapshotWav() {
    const out = Buffer.alloc(WINDOW_BYTES);
    if (this.ringFull) {
      const tail = WINDOW_BYTES - this.ringWritePos;
      this.ring.copy(out, 0, this.ringWritePos, WINDOW_BYTES);
      this.ring.copy(out, tail, 0, this.ringWritePos);
    } else {
      this.ring.copy(out, 0, 0, this.ringWritePos);
    }
    return Buffer.concat([wavHeader(out.length), out]);
  }

  windowHasSignal() {
    const view = new Int16Array(this.ring.buffer, this.ring.byteOffset,
                                this.ring.byteLength / 2);
    let acc = 0, count = 0;
    for (let i = 0; i < view.length; i += 16) {
      const s = view[i];
      acc += s * s;
      count++;
    }
    if (count === 0) return false;
    const rms = Math.sqrt(acc / count);
    return rms > 200;
  }

  maybeDecode() {
    if (this.closed) return;
    if (!this.ringFull && this.ringWritePos < SAMPLE_RATE * 2 * 5) return;  // <5 s buffered
    if (!this.windowHasSignal()) return;
    const wav = this.snapshotWav();
    const wavPath = path.join(this.tmpDir, `win-${Date.now()}.wav`);
    try {
      writeFileSync(wavPath, wav);
    } catch (e) {
      this.opts.onStatus?.(`wav write failed: ${e.message}`);
      return;
    }
    const child = spawn('python3', [DECODER, wavPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: SCRIPT_DIR,
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => {
      try { unlinkSync(wavPath); } catch {}
      if (this.closed) return;
      if (code !== 0) {
        process.stderr.write(`[cs406] decoder rc=${code} ${stderr.trim().slice(0, 200)}\n`);
        return;
      }
      const line = stdout.trim();
      if (!line) return;
      if (line === this.lastEmitted) return;
      this.lastEmitted = line;
      this.opts.onText?.(line);
      // Best-effort structured event extraction from the decoder's
      // text report. The script prints multiple fields; pull the
      // universally-interesting ones.
      const hexMatch     = line.match(/(?:Hex|Frame|ID)[:\s]+([0-9A-F]{20,})/i);
      const countryMatch = line.match(/Country[:\s]+(\d{1,3})/i);
      const typeMatch    = line.match(/(?:Beacon|Type)[:\s]+(EPIRB|ELT|PLB)/i);
      const latMatch     = line.match(/Lat(?:itude)?[:\s]+(-?\d+\.\d+)/i);
      const lonMatch     = line.match(/Lon(?:gitude)?[:\s]+(-?\d+\.\d+)/i);
      this.opts.onEvent?.({
        raw: line, tsMs: Date.now(),
        hex: hexMatch?.[1],
        country: countryMatch?.[1],
        type: typeMatch?.[1],
        lat: latMatch ? parseFloat(latMatch[1]) : undefined,
        lon: lonMatch ? parseFloat(lonMatch[1]) : undefined,
      });
    });
    child.on('error', (e) => {
      process.stderr.write(`[cs406] spawn error: ${e.message}\n`);
      try { unlinkSync(wavPath); } catch {}
    });
  }

  close() {
    this.closed = true;
    try { clearInterval(this.timer); } catch {}
    this.timer = null;
    try { rmSync(this.tmpDir, { recursive: true, force: true }); } catch {}
  }
}
