// LRPT / HRPT / APT (and other weather-sat protocols) decoder —
// satdump CLI, headless. Baseband IQ in (cs16 default), images out
// to a watched output directory.
//
// satdump 2.0 plumbing notes:
//   • The old `live_processing --input -` flag form is gone. v2 wraps
//     all pre-2.0 commands under `legacy <name>`; for file/baseband
//     pipeline input the syntax is:
//        satdump legacy <pipeline_id> baseband <input> <outdir>
//             --samplerate N --baseband_format cs16
//     There's no stdin support in offline mode — the pipeline fopens
//     the path and reads. We give it a named pipe so the bridge can
//     stream IQ over time instead of pre-buffering.

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, watch, readFile,
         openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'lrpt', 'bin', 'satdump');

/** Pipeline registry. Each entry maps the bridge's short key to the
 *  satdump pipeline id, the expected IQ sample rate (Hz), and the
 *  baseband format flag. The bridge upstream converts to cs16 LE
 *  already, so that's the default for everything. */
const PIPELINES = {
  lrpt: { name: 'meteor_m2_lrpt', samplerate: '150000',  format: 'cs16' },
  hrpt: { name: 'noaa_hrpt',      samplerate: '3000000', format: 'cs16' },
  apt:  { name: 'noaa_apt',       samplerate: '50000',   format: 'cs16' },
};

export class LrptDecoder {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.outDir = mkdtempSync(path.join(tmpdir(), 'radiom-lrpt-'));
    this.pipeline = (opts.pipeline in PIPELINES) ? opts.pipeline : 'lrpt';
    this.fifoPath = path.join(tmpdir(), `radiom-satdump-${process.pid}-${Date.now()}.iq`);
    this.fifoFd = -1;
    if (!existsSync(BIN)) { this.opts.onStatus?.('satdump missing — run `npm run build:lrpt`'); return; }
    try {
      execSync(`mkfifo ${this.fifoPath}`);
    } catch (e) {
      this.opts.onStatus?.(`mkfifo failed: ${e.message}`);
      return;
    }
    this.spawn();
    this.watcher = watch(this.outDir, (eventType, filename) => {
      if (eventType === 'rename' && filename && /\.(png|jpg)$/i.test(filename)) {
        const full = path.join(this.outDir, filename);
        if (!existsSync(full)) return;
        // Small debounce — satdump writes the file then mtimes it;
        // we want the final byte settled before reading.
        setTimeout(() => {
          readFile(full, (err, data) => {
            if (err) return;
            this.opts.onImage?.({
              name: filename,
              mime: filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
              bytes: data,           // Buffer — bridge forwards as WS binary
              tsMs: Date.now(),
            });
          });
        }, 300);
      }
    });
  }

  spawn() {
    try {
      const pl = PIPELINES[this.pipeline];
      // satdump 2.0 CLI:
      //   legacy <pipeline_id> baseband <input> <output_dir> [opts]
      // The `baseband` token is the input_level — tells the pipeline
      // to start at the baseband stage (vs already-demodulated soft
      // symbols or frames). cs16 = int16 LE interleaved IQ (the wire
      // shape from the rtl_tcp / OWRX bridges).
      this.proc = spawn(BIN, [
        'legacy',
        pl.name,
        'baseband',
        this.fifoPath,
        this.outDir,
        '--samplerate', pl.samplerate,
        '--baseband_format', pl.format,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { this.opts.onStatus?.(`spawn failed: ${e.message}`); return; }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => {
      const t = c.toString().trimEnd();
      for (const line of t.split('\n')) if (line.trim()) this.opts.onText?.(line.slice(0, 200));
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const t = c.toString().trimEnd();
      process.stderr.write(`[satdump] ${t}\n`);
      for (const line of t.split('\n')) if (line.trim()) this.opts.onStatus?.(line.slice(0, 200));
    });
    this.proc.on('exit', (code, signal) => {
      if (!this.closed) {
        const detail = `code=${code}${signal ? ` sig=${signal}` : ''}`;
        this.opts.onStatus?.(`satdump exited ${detail}`);
        process.stderr.write(`[satdump] exited ${detail}\n`);
      }
      this.proc = null;
    });
    this.proc.on('error', (e) => this.opts.onStatus?.(`satdump error: ${e.message}`));
    this.opts.onStatus?.(`listening (${this.pipeline.toUpperCase()})`);
    // Open the fifo for writing once the child is up; fopen() on the
    // reader side blocks until the writer opens. ~300ms is plenty.
    setTimeout(() => {
      try { this.fifoFd = openSync(this.fifoPath, 'w'); }
      catch (e) { this.opts.onStatus?.(`fifo open (write) failed: ${e.message}`); }
    }, 300);
  }

  /** Baseband IQ (cs16 LE interleaved). The OWRX / rtl_tcp bridges
   *  already normalize to this format upstream. */
  feed(buffer) {
    if (this.closed || this.fifoFd < 0) return;
    try { writeSync(this.fifoFd, buffer); } catch { /* EPIPE */ }
  }

  close() {
    this.closed = true;
    try { this.watcher?.close(); } catch {}
    try { if (this.fifoFd >= 0) closeSync(this.fifoFd); } catch {}
    this.fifoFd = -1;
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
    try { unlinkSync(this.fifoPath); } catch {}
  }
}
