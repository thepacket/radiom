// Generic multimon-ng bridge — one wrapper that handles the rest of
// the modes the binary supports beyond the SELCAL / POCSAG dedicated
// decoders. Currently:
//
//   flex     — FLEX paging (929/931 MHz US, 169 MHz EU)
//   dtmf     — DTMF tone decoder (touch-tone)
//   zvei     — ZVEI 5-tone selective calling (EU EMS/fire)
//   afsk1200 — Bell-202 AFSK 1200 bps (APRS, weather sondes, etc.)
//   x10      — X10 home-automation RF (310 MHz)
//   eas      — Emergency Alert System SAME header decoder
//
// Same audio-in / text-out wire shape as SELCAL: client streams 12 kHz
// int16 LE PCM up, bridge resamples to 22050 Hz (multimon-ng's expected
// rate) and pipes through `multimon-ng -a <MODE>`. Decoded events come
// back verbatim as JSON {t:"text", line:"..."} per stdout line, with a
// best-effort structured `event` extraction.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'decoders', 'multimon', 'bin', 'multimon-ng');

const KIWI_RATE     = 12_000;
const MULTIMON_RATE = 22_050;

/** multimon-ng -a takes uppercase mode names. Map UI mode → CLI arg(s). */
const MODE_ARGS = {
  flex:     ['-a', 'FLEX'],
  // FLEX_NEXT — newer revision of FLEX (Motorola, ~2010+). Decodes
  // standard FLEX frames and the next-gen variants with extra frame
  // types and tighter error handling. Strictly an additive demod;
  // catches things plain FLEX would miss in noisy conditions.
  flex_next: ['-a', 'FLEX_NEXT'],
  // UFSK1200 — Universal FSK at 1200 baud. Generic 2-FSK demod that
  // catches assorted non-AX.25 packet traffic (vehicle telematics,
  // industrial telemetry, some legacy radio paging links). Output is
  // raw hex frames; multimon-ng doesn't impose a protocol structure.
  ufsk1200: ['-a', 'UFSK1200'],
  // CLIPFSK — Bellcore / ETSI Caller-ID (CLIP — Calling Line
  // Identification Presentation) V.23 FSK at 1200 baud. Sent in the
  // silent gap between the first and second telephone ring on POTS
  // lines. Decodes the calling-party number / name / timestamp from
  // an inductively-coupled-or-leak audio source pointed at the phone
  // pair. Very niche on radio but multimon-ng exposes it natively.
  clipfsk:  ['-a', 'CLIPFSK'],
  // FMSFSK — German FMS Funkmeldesystem. 1200 bps BFSK status-code
  // signalling used by police, fire, EMS, civil defence, military
  // and utility services across DE / AT / CH-DE. Encodes BOS-ID +
  // 4-bit status code (e.g., "10 = vehicle en route to scene") and
  // optional short alphanumeric messages. Used on 4 m / 2 m / 70 cm
  // German emergency-services bands.
  fmsfsk:   ['-a', 'FMSFSK'],
  // AFSK2400 family — three tone-pair variants in multimon-ng's
  // ALL_DEMOD: AFSK2400 (Bell-202 at 2400 bps), AFSK2400_2 (V.23
  // 2400-bps variant), AFSK2400_3 (alternate tone pair). Run all
  // three concurrently like we do for ZVEI1/2/3 — multimon-ng
  // demodulates each independently and prints whichever matches.
  afsk2400: ['-a', 'AFSK2400', '-a', 'AFSK2400_2', '-a', 'AFSK2400_3'],
  // HAPN4800 — Hong Kong Amateur Packet Network, 4800 bps narrowband
  // FSK. Originally a regional HK packet network; the demod is still
  // useful for any 4800-bps FSK variant on UHF business / amateur
  // bands. Output is raw hex frames.
  hapn4800: ['-a', 'HAPN4800'],
  // FSK9600 — generic 9600 bps NRZ FSK. Some legacy packet networks
  // ran at this rate before G3RUH became standard. Direct FSK on
  // audio (not Bell-202 AFSK). Needs ≥19.2 kHz Nyquist; the multimon
  // demod handles its own resampling internally so 22050 Hz stdin
  // suffices.
  fsk9600:  ['-a', 'FSK9600'],
  // DZVEI / PZVEI — German + Polish ZVEI dialect variants. Different
  // stop-tone behaviour from ZVEI1/2/3. Bundle both into one button
  // matching the ZVEI / AFSK2400 bundling pattern; multimon-ng runs
  // each demod independently and prints whichever matches.
  dpzvei:   ['-a', 'DZVEI', '-a', 'PZVEI'],
  // MORSE (CWM) — multimon-ng's native Morse demod. Separate from
  // the fldigi-based CW button (different demod chain; CW button
  // gives richer output via fldigi's narrower filter + speed-track).
  // Useful as a sanity check / cross-validation against fldigi.
  morse:    ['-a', 'MORSE_CW'],
  // ERMES omitted — not a multimon-ng demod (no ERMES in ALL_DEMOD)
  // and the protocol is decommissioned. Button is hidden in the UI.
  dtmf:     ['-a', 'DTMF'],
  zvei:     ['-a', 'ZVEI1', '-a', 'ZVEI2', '-a', 'ZVEI3'],   // try all dialects
  afsk1200: ['-a', 'AFSK1200'],
  x10:      ['-a', 'X10'],
  eas:      ['-a', 'EAS'],
  // ── Paging-adjacent 5-tone selective-calling protocols.
  // multimon-ng's actual demod list (per multimon.h ALL_DEMOD):
  //   ZVEI1/2/3, DZVEI, PZVEI, EEA, EIA, CCIR — that's the whole
  //   5-tone family. CCITT, EURO, and DSC are NOT multimon-ng modes;
  //   passing them as -a returns "Unknown demodulator" → exit 2.
  ccir:     ['-a', 'CCIR'],        // 5-tone, ITU-R paging (originally Italian)
  // CCITT and CCIR share the same tone frequency table (the ITU-T
  // variant just differs on stop-tone handling). multimon-ng's CCIR
  // demod is lenient enough to catch CCITT transmissions too, so the
  // CCITT UI button routes through CCIR.
  ccitt:    ['-a', 'CCIR'],
  eea:      ['-a', 'EEA'],         // European EAS variant
  eia:      ['-a', 'EIA'],         // European industrial alert
  // "EURO" isn't a real 5-tone standard — it was an umbrella guess.
  // Route the UI button through the most generic European variant.
  euro:     ['-a', 'EEA'],
  // Marine DSC (ITU-R M.493) is its own protocol — multimon-ng has
  // no DSC demod. The client now routes 'dsc' to /ws/decode/dsc
  // (jbirby/DSC-Codec) so this entry exists only as a defensive
  // fallback for legacy clients hitting the multimon endpoint
  // directly. It produces no real DSC output but keeps the bridge
  // from exit-2'ing on an unknown demod.
  dsc:      ['-a', 'CCIR'],
};

export class MultimonDecoder {
  /**
   * @param {object} opts
   * @param {string} opts.mode  one of the keys of MODE_ARGS
   * @param {(line: string) => void}  [opts.onText]
   * @param {(event: object) => void} [opts.onEvent]
   * @param {(msg: string) => void}   [opts.onStatus]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.closed = false;
    this.stdoutBuf = '';
    this.mode = (opts.mode in MODE_ARGS) ? opts.mode : 'flex';
    this.resamplePhase = 0;
    this.resamplePrev = 0;
    this.resampleScratch = new Int16Array(16384);
    if (!existsSync(BIN)) {
      this.opts.onStatus?.('multimon-ng missing — run `npm run build:selcal`');
      return;
    }
    this.spawn();
  }

  spawn() {
    const modeArgs = MODE_ARGS[this.mode];
    try {
      // -t raw  : raw 22050 Hz int16 LE on stdin
      // -q      : skip the banner / mode-list at startup
      // -       : read from stdin
      this.proc = spawn(BIN, ['-t', 'raw', ...modeArgs, '-q', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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
        const t = line.trim();
        if (!t) continue;
        if (/error|fail|warn/i.test(t)) this.opts.onStatus?.(`[stderr] ${t.slice(0, 120)}`);
      }
    });
    this.proc.on('exit', (code) => {
      if (!this.closed) this.opts.onStatus?.(`multimon-ng exited code=${code}`);
      this.proc = null;
    });
    this.proc.on('error', (e) => this.opts.onStatus?.(`multimon-ng error: ${e.message}`));
    this.opts.onStatus?.(`listening (${this.mode.toUpperCase()})`);
  }

  consumeStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      this.opts.onText?.(line);
      const ev = this.parseLine(line);
      if (ev) this.opts.onEvent?.(ev);
    }
  }

  /** Best-effort line parser. Each mode has its own multimon output
   *  shape — we extract the universally-useful fields and dump the
   *  rest verbatim through onText. */
  parseLine(line) {
    const ev = { mode: this.mode, raw: line, tsMs: Date.now() };
    let m;
    // FLEX:  "FLEX|2006-01-02 15:04:05|1600/2/A/A|03.000.000|ALN|..."
    // FLEX_NEXT shares the same line format (multimon-ng's FLEX_NEXT
    // demod re-uses FLEX's print code), so the same parser applies.
    if ((this.mode === 'flex' || this.mode === 'flex_next')
        && (m = line.match(/FLEX\|[^|]+\|([\d/AB]+)\|([\d.]+)\|(\w+)\|(.*)/i))) {
      ev.fmt = m[1]; ev.ric = m[2]; ev.kind = m[3]; ev.payload = m[4];
      return ev;
    }
    // DTMF:  "DTMF: 1234*#A"
    if (this.mode === 'dtmf' && (m = line.match(/DTMF:\s*(\S+)/i))) {
      ev.digits = m[1];
      return ev;
    }
    // ZVEI:  "ZVEI1: 12345"  (call code)
    if (this.mode === 'zvei' && (m = line.match(/ZVEI\d?:\s*(\S+)/i))) {
      ev.code = m[1];
      return ev;
    }
    // AFSK1200 / EAS / X10 just surface the raw line; no extractable
    // fields without protocol-specific parsing.
    return null;
  }

  /** 12 kHz int16 LE in → 22050 Hz LE out → multimon-ng stdin. */
  feed(samples) {
    if (this.closed || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    const n = samples.length;
    if (n === 0) return;
    const need = Math.ceil(n * 2) + 8;
    if (this.resampleScratch.length < need) this.resampleScratch = new Int16Array(need);
    const out = this.resampleScratch;
    let w = 0;
    const ratio = KIWI_RATE / MULTIMON_RATE;
    let phase = this.resamplePhase;
    let prev = this.resamplePrev;
    for (let i = 0; i < n; i++) {
      const cur = samples[i];
      while (phase < 1) {
        const y = prev + (cur - prev) * phase;
        out[w++] = Math.max(-32768, Math.min(32767, y | 0));
        phase += ratio;
      }
      phase -= 1;
      prev = cur;
    }
    this.resamplePhase = phase;
    this.resamplePrev = prev;
    try {
      this.proc.stdin.write(Buffer.from(out.buffer, out.byteOffset, w * 2));
    } catch {}
  }

  close() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
  }
}
