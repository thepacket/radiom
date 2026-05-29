// Copyright (c) Andre Paquette
//
// csdr DSP pipeline — Node-side wrapper around the ha7ilm/csdr binary
// (the original OpenWebRX DSP toolkit). Turns raw int16 LE IQ samples
// from the SpyServer bridge into:
//
//   • Mono int16 LE audio PCM at ~12 kHz   — tagged TAG_AUDIO on the WS
//   • Uint8 dB-scaled FFT bins, 1024-wide  — tagged TAG_FFT on the WS
//
// Subcommand naming follows ha7ilm/csdr conventions:
//
//   convert_s16_f             int16 LE → float
//   convert_f_s16             float → int16 LE
//   shift_addition_cc <rate>  freq shift (no-op at rate 0)
//   bandpass_fir_fft_cc lo hi transition
//                             FFT-based brick-wall complex bandpass.
//                             lo/hi are normalised fractions of fs in
//                             [-0.5, +0.5]. Sharp transition gives
//                             true SDR-grade channel filter.
//   fir_decimate_cc N transition
//                             Decimate complex stream by N (filter then
//                             keep every Nth sample).
//   amdemod_cf                |IQ| AM envelope.
//   fmdemod_quadri_cf         Quadrature FM discriminator.
//   realpart_cf               Take real part of complex stream — used
//                             for SSB/CW after bandpass picks the
//                             sideband.
//   fastdcblock_ff            Adaptive DC block on float stream.
//   agc_ff                    Float audio AGC.
//   fft_cc N E                FFT every E samples, N-point.
//   logpower_cf <add_db>      Convert complex FFT to dB power.
//   compress_fft_adpcm_f_u8 N OpenWebRX-style uint8 dB-bin packing.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve csdr in this order:
//   1. $CSDR_BIN env var (explicit override)
//   2. decoders/csdr/bin/csdr (the Docker-built location)
//   3. /usr/local/bin/csdr (typical brew/local-install location on Mac)
//   4. just `csdr` (rely on PATH)
// This lets `node server.mjs` work locally on a dev box that has
// `brew install fftw libsamplerate && make && sudo make install`-ed
// ha7ilm/csdr, without needing CSDR_BIN to be set.
function resolveCsdrBin() {
  if (process.env.CSDR_BIN) return process.env.CSDR_BIN;
  const candidates = [
    path.resolve(__dirname, '..', 'decoders', 'csdr', 'bin', 'csdr'),
    '/usr/local/bin/csdr',
    '/opt/homebrew/bin/csdr',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* nope */ }
  }
  return 'csdr';
}
const CSDR_BIN = resolveCsdrBin();

const MODE_PASSBANDS_HZ = {
  am:   { lo: -4500,  hi:  4500  },
  sam:  { lo: -4500,  hi:  4500  },
  sal:  { lo: -4500,  hi:  -100  },   // synchronous AM, LSB-only
  sau:  { lo:   100,  hi:  4500  },   // synchronous AM, USB-only
  nbfm: { lo: -6000,  hi:  6000  },
  nfm:  { lo: -6000,  hi:  6000  },
  wfm:  { lo: -75000, hi:  75000 },
  usb:  { lo:   300,  hi:  2700  },
  lsb:  { lo: -2700,  hi:  -300  },
  cw:   { lo:   400,  hi:   900  },
  iq:   { lo: -6000,  hi:  6000  },   // irrelevant for IQ (no audio); placeholder
};

const MODE_DEMOD = {
  am:   { cmd: 'amdemod_cf',        outRate: 12000 },
  // sam/sal/sau already collapse to 'am' in the bridge via
  // MODE_TO_DEMOD, but list them here too so a direct pipeline
  // .setMode('sam') call doesn't fall back to 'usb'.
  sam:  { cmd: 'amdemod_cf',        outRate: 12000 },
  sal:  { cmd: 'amdemod_cf',        outRate: 12000 },
  sau:  { cmd: 'amdemod_cf',        outRate: 12000 },
  nbfm: { cmd: 'fmdemod_quadri_cf', outRate: 12000 },
  nfm:  { cmd: 'fmdemod_quadri_cf', outRate: 12000 },
  wfm:  { cmd: 'fmdemod_quadri_cf', outRate: 48000 },
  usb:  { cmd: 'realpart_cf',       outRate: 12000 },
  lsb:  { cmd: 'realpart_cf',       outRate: 12000 },
  cw:   { cmd: 'realpart_cf',       outRate: 12000 },
  // 'iq' means the user wants raw IQ for client-side viewers (waterfall,
  // constellation, etc.) — no audio demod. The pipeline detects this
  // and skips spawning the audio chain entirely; only FFT runs.
  iq:   { cmd: null,                outRate: 12000, skipAudio: true },
};

export class CsdrPipeline {
  /**
   * @param {object} opts
   * @param {number} opts.inputRate
   * @param {string} opts.mode
   * @param {(buf: Buffer) => void} opts.onAudio
   * @param {(buf: Buffer) => void} [opts.onFft]
   * @param {(msg: string) => void} [opts.onStatus]
   */
  constructor(opts) {
    this.opts = opts;
    this.inputRate = opts.inputRate | 0;
    this.mode = String(opts.mode || 'usb').toLowerCase();
    // User-controlled passband (signed Hz around the dial). When set,
    // overrides MODE_PASSBANDS_HZ defaults — this is what the BW knob
    // drives. null until shell pushes a passband.
    this.passLoHz = Number.isFinite(opts.passLoHz) ? opts.passLoHz : null;
    this.passHiHz = Number.isFinite(opts.passHiHz) ? opts.passHiHz : null;
    // Bandpass FIR tap count — drives transition_bw. csdr derives the
    // tap count from transition_bw internally; we invert the relation
    // here so users think in taps instead of normalised transitions.
    // HAMMING window rule of thumb: taps ≈ 3.3 / transition_bw → so
    // transition_bw ≈ 3.3 / taps. Clamped 50..4000 to avoid degenerate
    // filters or runaway FFT sizes.
    this.bandpassTaps = (Number.isFinite(opts.bandpassTaps) && opts.bandpassTaps >= 50)
      ? Math.round(opts.bandpassTaps) : 801;
    // Audio AGC profile — 'off' drops the agc_ff stage entirely
    // (fixed-gain demod). 'fast'/'med'/'slow' use csdr's named
    // profiles; 'med' falls through to 'fast' since csdr only has
    // two profiles.
    const allowedAgc = new Set(['off', 'fast', 'med', 'slow']);
    // Default to 'off' — AGC chases the noise floor on silent channels
    // and produces clipping spikes through limit_ff that are louder
    // than any real signal. Better to leave the demod output alone
    // and let the user ride RF gain / volume manually. The shell can
    // still opt into AGC explicitly via setAgcProfile.
    this.agcProfile = allowedAgc.has(opts.agcProfile) ? opts.agcProfile : 'off';
    // Fixed post-demod gain applied in 'off' mode. SSB demod output
    // is ~0.02 at typical levels; ×8 → 0.16, comfortable headroom.
    this.fixedGain = (Number.isFinite(opts.fixedGain) && opts.fixedGain > 0)
      ? opts.fixedGain : 8;
    // Frequency-shift is now applied JS-side in the bridge before
    // samples reach csdr (see decoder/spyserver.mjs feedCsdr). The
    // pipeline no longer needs to know about it — that avoided
    // a full process-respawn on every dial change.
    this.audioProc = null;
    this.fftProc = null;
    this.audioOutRate = MODE_DEMOD[this.mode]?.outRate ?? 12000;
    this.build();
  }

  build() {
    this.stop();
    if (!this.inputRate) return;
    const mode = MODE_DEMOD[this.mode] ? this.mode : 'usb';
    const demod = MODE_DEMOD[mode];
    // Prefer user-supplied passband (from the BW knob) over the mode
    // default. The user value is signed Hz around the dial — same
    // convention as MODE_PASSBANDS_HZ. Required for SSB/CW where the
    // BW knob is the only useful audio filter control.
    const pass = (this.passLoHz != null && this.passHiHz != null &&
                  this.passHiHz > this.passLoHz)
      ? { lo: this.passLoHz, hi: this.passHiHz }
      : MODE_PASSBANDS_HZ[mode];
    this.audioOutRate = demod.outRate;

    // ARCHITECTURE: csdr always outputs at a FIXED audio rate (12 kHz
    // for AM/SSB/NBFM/CW, 48 kHz for WFM) regardless of input rate.
    // We use integer fir_decimate_cc on the complex stream to land
    // close to the target, then a real-domain fractional_decimator_ff
    // after the demod to nail the rate exactly.
    //
    // This means the player NEVER has to retune: the audio rate is
    // constant for the lifetime of the WS session. Previous variable-
    // rate design caused pitch shift / time stretch / on-off bursts
    // every time the upstream IQ rate changed (i.e. on every BW
    // change and every cross-server tune).
    const targetRate = demod.outRate;
    // Largest int decim such that postDecimRate >= targetRate (so the
    // fractional decimator that follows is always >= 1.0).
    const decim = Math.max(1, Math.floor(this.inputRate / targetRate));
    const postDecimRate = Math.floor(this.inputRate / decim);
    // Fractional decimator rate to hit exactly targetRate.
    const fracDecim = (postDecimRate / targetRate).toFixed(6);
    this.audioOutRate = targetRate;
    // Normalised passband cutoffs (fraction of fs).
    const loN = (pass.lo / this.inputRate).toFixed(6);
    const hiN = (pass.hi / this.inputRate).toFixed(6);
    // Bandpass transition width — critical for SSB. csdr's
    // bandpass_fir_fft_cc treats transition_bw as a normalised
    // fraction of fs. At fs=14250 a transition of 0.05 is 712 Hz
    // PER edge — that eats >50% of a 2.4 kHz SSB passband, leaving
    // almost no signal (scratchy noise). AM tolerates it because its
    // symmetric ±2.25 kHz passband has more headroom.
    //
    // 0.005 (~71 Hz at 14250 sps) gives a true brick-wall channel
    // filter — same value OpenWebRX uses for SSB.
    // ha7ilm/csdr's firdes.c derives taps as `4 / transition_bw`
    // (rounded up + made odd), so the inverse for our user-facing
    // tap count is exactly transition_bw = 4 / taps. The status log
    // shows both so it's easy to verify csdr's reported taps_length
    // matches the user's requested count.
    const bandpassTrans = 4 / this.bandpassTaps;
    // The decimation filter just needs anti-aliasing — wider transition
    // is fine and uses fewer taps.
    const decimTrans = 0.05;

    // agc_ff <profile> — "slow" has a longer hang time and gentler
    // attack/decay than the default "fast", which is what voice/music
    // listening wants. Default "fast" pumps gain on every silent gap
    // and produces the on/off character that sounds like demod is
    // dropping out.
    //
    // gain_ff after the AGC gives a final volume trim — csdr's AGC
    // targets reference 0.8 internally; multiplying by 0.5 keeps
    // typical voice below clipping in the browser's float→int path.
    // Channel filter: asymmetric complex bandpass directly at the
    // signed passband cutoffs — no shift, no recentering. For LSB the
    // cutoffs are both negative (e.g. -2700..-300); for USB both
    // positive (+300..+2700). After bandpass + realpart_cf:
    //   • LSB: I-channel at IQ frequency -f is cos(2π·f·t) → audio
    //   • USB: I-channel at IQ frequency +f is cos(2π·f·t) → audio
    // Crucially this keeps tone frequency invariant when the user
    // changes BW — shifting the spectrum for SSB-centering re-tunes
    // the receiver whenever lo or hi moves, and folds both halves of
    // the filtered band into mono audio (DSB-like result).
    //
    const preStages = [
      `${CSDR_BIN} bandpass_fir_fft_cc ${loN} ${hiN} ${bandpassTrans}`,
      `${CSDR_BIN} fir_decimate_cc ${decim} ${decimTrans}`,
    ];
    // Post-demod chain: DC block → fractional decimator (locks rate
    // to exactly targetRate) → AGC → int16.
    //
    // CRITICAL: each csdr stage is prefixed with `stdbuf -o0` to
    // disable libc stdio buffering on stdout. Without this, every
    // pipe between stages full-buffers up to 64 KB before flushing —
    // at 24 KB/s audio that's ~2.5 seconds of latency PER STAGE.
    // With 10 stages we were stacking many seconds of round-trip lag
    // even though the actual DSP runs in real time. `stdbuf -o0` is
    // a coreutils helper that forces unbuffered output.
    //
    // GAIN: agc_ff (default profile) targets reference 0.8 — gain_ff
    // 2.0 then pushed peaks to 1.6 which limit_ff hard-clipped to
    // ±1.0, sounding like AGC distortion / clipping. gain_ff 1.0
    // keeps peaks at 0.8, well below clipping; limit_ff is now a
    // safety net only.
    const SB = 'stdbuf -o0';
    // AGC stage. 'off' = NO agc stage at all (passthrough). The
    // assumption is the user has set RF gain manually and wants the
    // demod output to feed through unmodified. A previous attempt
    // substituted `gain_ff 0.5` which halved the level → audio went
    // inaudible. Keeping it at unity preserves whatever level the
    // demod produces, which is what manual-gain users expect.
    //
    // 'fast' / 'med' = csdr's default agc_ff profile (aggressive).
    // 'slow' = csdr's slow profile (gentle, voice-friendly).
    const stages = [
      `${SB} ${CSDR_BIN} convert_s16_f`,
      ...preStages.map(s => `${SB} ${s}`),
      `${SB} ${CSDR_BIN} ${demod.cmd}`,
      `${SB} ${CSDR_BIN} fastdcblock_ff`,
      `${SB} ${CSDR_BIN} fractional_decimator_ff ${fracDecim}`,
    ];
    // Back to the simple `agc_ff [slow]` form — the explicit-params
    // form (`agc_ff slow 600 0.5 ...`) silently killed the pipeline
    // in ha7ilm/csdr's binary, taking audio with it. The default
    // params over-amplify noise (max_gain=65536) but that's a
    // separate problem to solve via squelch / different topology
    // rather than by passing unparseable args.
    if (this.agcProfile === 'slow') {
      stages.push(`${SB} ${CSDR_BIN} agc_ff slow`);
    } else if (this.agcProfile === 'fast' || this.agcProfile === 'med') {
      stages.push(`${SB} ${CSDR_BIN} agc_ff`);
    } else {
      // AGC=off: demod output levels are typically 0.01..0.05 for
      // SSB/AM, far below comfortable listening volume. A fixed
      // post-demod gain brings the default level up to "audible
      // without cranking" while limit_ff downstream catches any
      // signal that exceeds full-scale. No dynamic compression /
      // pumping / clipping artifacts — just a static multiplier.
      stages.push(`${SB} ${CSDR_BIN} gain_ff ${this.fixedGain}`);
    }
    stages.push(`${SB} ${CSDR_BIN} limit_ff`);
    stages.push(`${SB} ${CSDR_BIN} convert_f_s16`);
    const audioPipe = stages.join(' | ');
    // In IQ mode the user wants raw IQ samples (for waterfall /
    // constellation / etc. viewers), not demodulated audio. Skip the
    // entire audio chain — saves CPU and prevents nonsense PCM
    // landing in the speakers.
    const skipAudio = !!demod.skipAudio;
    if (!skipAudio) {
      // csdr writes int16 in native byte order (little-endian on x86),
      // but the browser player's pushAudio path uses decodePcmBe and
      // expects BIG-endian (Kiwi convention reused everywhere else in
      // radiom). Byte-swap each sample pair before forwarding.
      this.audioProc = this.spawnPipe(audioPipe, (b) => {
        const out = Buffer.allocUnsafe(b.length & ~1);
        for (let i = 0; i + 1 < b.length; i += 2) {
          out[i]     = b[i + 1];
          out[i + 1] = b[i];
        }
        this.opts.onAudio?.(out);
      }, 'audio');
    }

    // FFT chain — ~30 fps @ 1024 bins. Outputs float dB values
    // (4 bytes/bin) which we map to Kiwi-style uint8 (0..255 →
    // mindb..maxdb dBm) in JS. compress_fft_adpcm_f_u8 was an option
    // but its 4-bit ADPCM encoding would need a custom decoder on
    // the browser side; uncompressed bytes are simpler and the
    // bandwidth (1024 × 30 = 30 KB/s) is negligible.
    const fftSize = 1024;
    const fftFps = 20;
    const samplesPerFrame = Math.max(1, Math.floor(this.inputRate / fftFps));
    const fftPipe = [
      `${SB} ${CSDR_BIN} convert_s16_f`,
      `${SB} ${CSDR_BIN} fft_cc ${fftSize} ${samplesPerFrame}`,
      `${SB} ${CSDR_BIN} logpower_cf -70`,
    ].join(' | ');
    // Kiwi-format dBm range: 0..255 = mindb..maxdb. Keep in sync
    // with src/kiwi/types.ts dbmFromByte defaults.
    const MIN_DB = -130;
    const MAX_DB = -30;
    const SCALE = 255 / (MAX_DB - MIN_DB);
    if (this.opts.onFft) {
      // Accumulate a fftSize worth of floats then emit a single
      // uint8 frame. csdr writes floats in chunks, not necessarily
      // aligned to frame boundaries, so buffer until we have a full
      // fftSize × 4 bytes.
      let buf = Buffer.alloc(0);
      const FRAME_BYTES = fftSize * 4;
      this.fftProc = this.spawnPipe(fftPipe, (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (buf.length >= FRAME_BYTES) {
          const frame = buf.subarray(0, FRAME_BYTES);
          buf = buf.subarray(FRAME_BYTES);
          // Re-order bins: csdr's fft_cc + logpower_cf outputs DC at
          // index 0, then positive freqs, then negative freqs (FFT
          // natural order). Spectrum viewers expect negative on the
          // left, DC in the middle, positive on the right — same as
          // a fftswap'd layout. Swap halves.
          const out = new Uint8Array(fftSize);
          const half = fftSize >> 1;
          for (let i = 0; i < fftSize; i++) {
            // Read float32 LE from csdr's natural-order frame.
            const srcIdx = (i + half) % fftSize;
            const db = frame.readFloatLE(srcIdx * 4);
            let v = (db - MIN_DB) * SCALE;
            if (v < 0) v = 0; else if (v > 255) v = 255;
            out[i] = v | 0;
          }
          this.opts.onFft?.(Buffer.from(out.buffer));
        }
      }, 'fft');
    }

    this.opts.onStatus?.(
      `csdr pipeline up: mode=${mode} inputRate=${this.inputRate} ` +
      `pass=[${pass.lo}..${pass.hi}] (loN=${loN} hiN=${hiN}) ` +
      `decim=${decim} postDecimRate=${postDecimRate} fracDecim=${fracDecim} ` +
      `audioRate=${this.audioOutRate} taps=${this.bandpassTaps} trans=${bandpassTrans.toFixed(6)} ` +
      `agc=${this.agcProfile} fft=${this.opts.onFft ? 'on' : 'off'}`
    );
  }

  spawnPipe(pipeStr, onData, tag) {
    const proc = spawn('/bin/sh', ['-c', pipeStr], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Generation-guarded stdout: SIGTERM doesn't kill child processes
    // synchronously — they can keep emitting PCM for hundreds of ms
    // after kill() while their shell pipe drains. If we just attach
    // the data handler unconditionally, the OLD pipeline's output
    // continues to land in onAudio after a mode/passband change kicks
    // off a NEW pipeline, and the two demods get interleaved on the
    // WS = persistent buzzing that never recovers. Gate every chunk
    // on "am I still the active process for my role?" — old generations
    // become no-ops as soon as the new spawn replaces them.
    const role = tag;
    proc.stdout.on('data', (buf) => {
      const current = role === 'audio' ? this.audioProc : this.fftProc;
      if (current !== proc) return;       // we've been superseded — drop
      onData(buf);
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString('utf8').trim();
      if (s) this.opts.onStatus?.(`csdr[${tag}]: ${s.slice(0, 240)}`);
    });
    proc.on('error', (e) => this.opts.onStatus?.(`csdr[${tag}] err: ${e.message}`));
    proc.on('close', (code) => this.opts.onStatus?.(`csdr[${tag}] exit ${code}`));
    return proc;
  }

  feedIq(buf) {
    if (this.audioProc && !this.audioProc.killed) {
      try { this.audioProc.stdin.write(buf); } catch {}
    }
    if (this.fftProc && !this.fftProc.killed) {
      try { this.fftProc.stdin.write(buf); } catch {}
    }
  }

  setInputRate(rate) {
    const r = rate | 0;
    if (r === this.inputRate || r < 1000) return;
    this.inputRate = r;
    this.build();
  }

  setMode(mode) {
    const m = String(mode || '').toLowerCase();
    if (!MODE_DEMOD[m] || m === this.mode) return;
    this.mode = m;
    this.build();
  }

  /** Set fixed post-demod gain (used when AGC is 'off'). Rebuilds. */
  setFixedGain(g) {
    if (!Number.isFinite(g) || g <= 0 || g === this.fixedGain) return;
    this.fixedGain = g;
    this.build();
  }

  /** Set audio AGC profile. Rebuilds the pipeline. */
  setAgcProfile(profile) {
    const allowed = new Set(['off', 'fast', 'med', 'slow']);
    const p = String(profile || '').toLowerCase();
    if (!allowed.has(p) || p === this.agcProfile) return;
    this.agcProfile = p;
    this.build();
  }

  /** Set FIR tap count for the bandpass channel filter. Rebuilds. */
  setBandpassTaps(n) {
    if (!Number.isFinite(n) || n < 50) return;
    const next = Math.max(50, Math.min(4000, Math.round(n)));
    if (next === this.bandpassTaps) return;
    this.bandpassTaps = next;
    this.build();
  }

  /** Set audio passband cutoffs in signed Hz (relative to dial freq).
   *  Rebuilds the chain — same cost as setMode. ha7ilm csdr blocks
   *  have no runtime parameter-change hooks, so a full rebuild is the
   *  only correct way to update the bandpass.
   *
   *  Light 60 ms debounce so a slider drag coalesces into one rebuild
   *  but a single BW-preset tap feels instant. */
  setPassband(loHz, hiHz) {
    if (!Number.isFinite(loHz) || !Number.isFinite(hiHz) || hiHz <= loHz) return;
    if (loHz === this.passLoHz && hiHz === this.passHiHz) return;
    this.passLoHz = loHz;
    this.passHiHz = hiHz;
    if (this._passDebounceTimer != null) clearTimeout(this._passDebounceTimer);
    this._passDebounceTimer = setTimeout(() => {
      this._passDebounceTimer = null;
      this.build();
    }, 60);
  }

  getAudioRate() { return this.audioOutRate; }

  stop() {
    if (this._passDebounceTimer != null) {
      clearTimeout(this._passDebounceTimer);
      this._passDebounceTimer = null;
    }
    for (const p of [this.audioProc, this.fftProc]) {
      if (!p) continue;
      try { p.stdin.end(); } catch {}
      try { p.kill('SIGTERM'); } catch {}
    }
    this.audioProc = null;
    this.fftProc = null;
  }
}
