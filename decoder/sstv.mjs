// SSTV decoder — Node-side wrapper around the headless `slowrxd`
// binary from sjlongland/slowrxd (a fork of windytan/slowrx with the
// GTK GUI replaced by JSON-on-stdout + PNG-to-directory).
//
// Pipeline:
//
//   Kiwi 12 kHz int16 PCM  ── stdin ──▶  slowrxd
//                                          │
//                                          ├─▶ stdout: JSON events
//                                          │     (VIS, MODE, IMAGE, …)
//                                          │
//                                          └─▶ /tmp/.../<n>.png
//                                              (one file per completed
//                                               image, latest filename
//                                               surfaced via the JSON
//                                               event stream)
//
// We watch the tmp dir for new PNGs, base64-encode each finished
// image, and forward both the file payload and any JSON status events
// to the WS client.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync, readdir, readFile, watch as fsWatch } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const readdirAsync = promisify(readdir);
const readFileAsync = promisify(readFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'sstv', 'bin', 'slowrxd');

/** Slowrxd's expected input sample rate; we tell it 12 kHz to match
 *  the Kiwi's PCM mode so no resampling is needed. SSTV's analog
 *  carriers all live below 2400 Hz, so 12 kHz Nyquist is fine. */
const SAMPLE_RATE = 12_000;

export class SstvDecoder {
  /**
   * @param {object} opts
   * @param {() => number} opts.dialFreqKHz
   * @param {(image: { mode: string, dataUrl: string, tsMs: number }) => void} [opts.onImage]
   * @param {(msg: string) => void}  [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.closed = false;
    this.outDir = mkdtempSync(path.join(tmpdir(), 'radiom-sstv-'));
    this.proc = null;
    this.watcher = null;
    this.seenFiles = new Set();
    this.stdoutBuf = '';
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('slowrxd binary missing — run `npm run build:sstv`');
      return;
    }
    this.spawn();
  }

  spawn() {
    try {
      // slowrxd CLI: -i - reads PCM from stdin; -r sets sample rate;
      // -o sets output directory; --json emits structured events on
      // stdout instead of human-readable log lines.
      this.proc = spawn(BIN, [
        '-i', '-',
        '-r', String(SAMPLE_RATE),
        '-o', this.outDir,
        '--json',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.opts.onStatus?.(`spawn failed: ${e.message}`);
      return;
    }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.consumeStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trimEnd();
      for (const line of text.split('\n')) {
        if (line.trim()) this.opts.onStatus?.(`[stderr] ${line.trim()}`);
      }
    });
    this.proc.on('exit', (code) => {
      if (!this.closed) this.opts.onStatus?.(`slowrxd exited code=${code}`);
      this.proc = null;
    });
    this.proc.on('error', (e) => {
      this.opts.onStatus?.(`slowrxd error: ${e.message}`);
    });

    // Watch the output directory for new PNG files. fs.watch is
    // platform-quirky but for "polling for new files in a small dir"
    // it's adequate; we fall back to a periodic readdir if the
    // watcher fires too eagerly.
    try {
      this.watcher = fsWatch(this.outDir, { persistent: false }, (ev, fname) => {
        if (!fname || !fname.endsWith('.png')) return;
        // Debounce — slowrxd writes the file then renames; wait briefly
        // for the rename to settle.
        setTimeout(() => this.scanForNewImages(), 100);
      });
    } catch (e) {
      this.opts.onStatus?.(`watcher unavailable: ${e.message}`);
    }
    // Periodic fallback in case fs.watch misses events.
    this._scanTimer = setInterval(() => this.scanForNewImages(), 2_000);
  }

  /** Drain slowrxd's JSON event stream. Each line is a JSON object;
   *  we forward `STATUS`/`MODE`/`IMAGE` types to the client and use
   *  `IMAGE` events to trigger a scan of the output directory. */
  consumeStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      // slowrxd event shape: { type: 'VIS' | 'MODE' | 'IMAGE' | 'STATUS' | ..., ... }
      const t = evt?.type ?? evt?.t ?? '';
      if (t === 'IMAGE' || t === 'image' || evt?.filename) {
        this.scanForNewImages();
      } else if (t === 'MODE' || t === 'mode') {
        this.opts.onStatus?.(`mode: ${evt.name ?? evt.mode ?? '?'}`);
      } else if (t === 'VIS' || t === 'vis') {
        this.opts.onStatus?.(`VIS: ${evt.code ?? '?'}`);
      } else if (t === 'STATUS' || t === 'status') {
        this.opts.onStatus?.(evt.msg ?? evt.message ?? line);
      } else {
        this.opts.onStatus?.(line);
      }
    }
  }

  /** List the output dir; any PNG we haven't seen before gets read,
   *  base64-encoded, and forwarded to the client. The mode name is
   *  inferred from the file naming convention slowrxd uses
   *  (`<timestamp>_<mode>.png`). */
  async scanForNewImages() {
    if (this.closed) return;
    let names;
    try { names = await readdirAsync(this.outDir); } catch { return; }
    for (const fn of names) {
      if (!fn.endsWith('.png') || this.seenFiles.has(fn)) continue;
      this.seenFiles.add(fn);
      try {
        const full = path.join(this.outDir, fn);
        const buf = await readFileAsync(full);
        const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
        // Best-effort mode extraction; falls back to the bare filename.
        const m = fn.match(/_(?:mode-)?([A-Za-z0-9]+)\.png$/);
        const mode = m ? m[1] : fn.replace(/\.png$/, '');
        this.opts.onImage?.({ mode, dataUrl, tsMs: Date.now() });
        // We've shipped the PNG to the client; we can drop it from
        // disk so the tmp dir doesn't bloat across long sessions.
        try { rmSync(full); } catch {}
      } catch (e) {
        this.opts.onStatus?.(`read failed: ${e.message}`);
      }
    }
  }

  /** Pipe 12 kHz int16 LE PCM into slowrxd's stdin. */
  feed(samples) {
    if (this.closed || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    try {
      this.proc.stdin.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    } catch {}
  }

  close() {
    this.closed = true;
    if (this._scanTimer) { clearInterval(this._scanTimer); this._scanTimer = null; }
    try { this.watcher?.close(); } catch {}
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.watcher = null;
    this.proc = null;
    // Tear down the tmp dir.
    try { rmSync(this.outDir, { recursive: true, force: true }); } catch {}
  }
}
