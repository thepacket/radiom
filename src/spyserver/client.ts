// Copyright (c) Andre Paquette
//
// SpyServer client — speaks the radiom-proxied WS form
// (/ws/spyserver/<host>:<port>) to surface int16 LE IQ samples
// through the same player-side hooks the KiwiSDR / OpenWebRX / rtl_tcp
// clients use.
//
// Like rtl_tcp, this is **IQ-only** at the client. Demod happens in
// the browser via the player's existing IQ pipeline (ISB / SSBf / etc.)
// or via any of the IQ-side viewers.
//
// JSON protocol with the proxy:
//   ◄ { t:"hello", device, srOut, minHz, maxHz, maxGain, ... }
//   ◄ { t:"status", msg:"..." }
//   ◄ binary int16 LE IQ frames at `srOut`
//   ► { t:"freq", hz } | { t:"gain", idx }

export interface SpyServerClientOpts {
  /** host:port — e.g. "spy.example.com:5555". */
  url: string;
  /** Initial centre frequency in Hz. */
  centerHz?: number;
  /** Initial gain index (0..maxGain). Resolved server-side. */
  gainIdx?: number;
  /** Initial demod mode (am / usb / lsb / cw / nbfm / wfm). */
  mode?: string;
  /** Initial audio passband bandwidth in Hz. */
  bandwidthHz?: number;
  /** Number of FIR taps in the server-side csdr bandpass channel
   *  filter. Maps to the bridge's `taps` JSON command which the csdr
   *  pipeline turns into a `transition_bw` for bandpass_fir_fft_cc.
   *  More taps = sharper transitions; default 801. */
  bandpassTaps?: number;
  /** AGC profile for the server-side csdr pipeline. */
  agcProfile?: 'off' | 'fast' | 'med' | 'slow';
  /** Fixed post-demod gain applied when AGC is 'off'. */
  fixedGain?: number;
}

export interface SpyServerHandlers {
  onMessage?: (kv: Record<string, string>) => void;
  onIq?: (iqBytes: Uint8Array) => void;
  /** Server-side-demodulated audio — int16 BE PCM at the rate the
   *  bridge reports in its hello (`audio_rate`). */
  onAudio?: (audioBytes: Uint8Array) => void;
  /** Server-side FFT — uint8 dB-scaled bin values, 1024 bins. */
  onFft?: (fftBytes: Uint8Array) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
  onStatus?: (s: { connected: boolean }) => void;
}

// Bitfield for SpyServer's STREAMING_MODE setting. Combinable.
export const SPY_STREAM_IQ    = 0x01;
export const SPY_STREAM_AUDIO = 0x02;
export const SPY_STREAM_FFT   = 0x04;

// Binary WS frame tag bytes — must match the bridge.
const TAG_IQ    = 0x00;
const TAG_AUDIO = 0x01;
const TAG_FFT   = 0x02;

export class SpyServerClient {
  private ws: WebSocket | null = null;
  private opts: SpyServerClientOpts;
  private h: SpyServerHandlers;
  private gotHello = false;
  private pendingCenterHz: number | null;
  private pendingGainIdx:  number | null;
  private pendingMode:        string | null = null;
  private pendingBwHz:        number | null = null;
  private pendingStreamMode:  number | null = null;
  private pendingPass:        { lo: number; hi: number } | null = null;
  private pendingTaps:        number | null = null;
  private pendingAgc:         'off' | 'fast' | 'med' | 'slow' | null = null;
  private pendingFixedGain:   number | null = null;
  /** Output sample rate reported by the bridge in its hello message.
   *  Set when the JSON hello arrives; consumed by external callers
   *  through `getOutputRate()`. */
  private outputRate = 0;
  /** Maximum gain index supported by the upstream SpyServer (from
   *  hello). Drives the manGain → gainIdx mapping in setAgc. 0 means
   *  the device exposes no gain control (typical for Airspy HF+). */
  private maxGain = 0;
  /** The frequency we last actually tuned the SpyServer to. Distinct
   *  from pendingCenterHz — pendingCenterHz tracks the user's dial,
   *  serverCenterHz tracks the upstream's view centre. They diverge
   *  when the user moves the dial within the visible IQ window
   *  without us re-tuning the server. */
  private serverCenterHz = 0;

  constructor(opts: SpyServerClientOpts, handlers: SpyServerHandlers) {
    this.opts = opts;
    this.h = handlers;
    this.pendingCenterHz = opts.centerHz ?? null;
    this.pendingGainIdx  = opts.gainIdx ?? null;
    this.pendingMode     = opts.mode ?? null;
    this.pendingBwHz     = opts.bandwidthHz ?? null;
    this.pendingTaps     = opts.bandpassTaps ?? null;
    this.pendingAgc      = opts.agcProfile ?? null;
    this.pendingFixedGain = (Number.isFinite(opts.fixedGain) ? opts.fixedGain! : null);
    this.open();
  }

  private wsUrl(): string {
    const m = this.opts.url.match(/^([\w.-]+):(\d+)$/);
    if (!m) throw new Error(`bad spyserver URL: ${this.opts.url}`);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}/ws/spyserver/${m[1]}:${m[2]}`;
  }

  private open(): void {
    let url: string;
    try { url = this.wsUrl(); } catch (e) { this.h.onError?.(e as Error); return; }
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      // Browser-side WebSocket is open; the bridge is now talking to
      // the upstream spyserver. The shell expects `connected: true`
      // only AFTER the spyserver has actually responded, so we defer
      // that event until the JSON hello arrives.
      this.h.onMessage?.({ _debug: `spyserver connecting via ${url}` });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      if (typeof e.data === 'string') {
        try {
          const m = JSON.parse(e.data);
          if (m.t === 'hello') {
            // The bridge emits a new hello on every configureStream call
            // (so: every BW change). Only apply pending state on the
            // FIRST hello — otherwise stale pendings from connect-time
            // would clobber whatever the user has since changed live.
            const firstHello = !this.gotHello;
            this.gotHello = true;
            this.outputRate = Math.max(1, Math.round(+m.srOut || 0));
            this.maxGain = Math.max(0, Math.round(+m.maxGain || 0));
            this.h.onStatus?.({ connected: true });
            // audioRate (when present) is the actual sample rate of
            // the csdr server-side audio chain (post-decimation).
            // If the bridge sends a hello before the csdr pipeline is
            // up (e.g. during a BW change), audioRate is null/0 — DO
            // NOT fall back to the IQ rate (`srOut`) for audio_rate;
            // that would tell the player to play 12500-Hz PCM at
            // 24000 Hz → pitch shift + time stretch + underruns. The
            // bridge emits a follow-up hello via announceCsdrRate()
            // as soon as the pipeline rebuilds.
            const audioRateValid = Number.isFinite(+m.audioRate) && +m.audioRate > 0;
            const audioRate = audioRateValid ? Math.round(+m.audioRate) : null;
            const kv: Record<string, string> = {
              _debug: `spyserver hello device=${m.device} srOut=${m.srOut} audioRate=${audioRate ?? '?'} range=${m.minHz}..${m.maxHz} maxGain=${m.maxGain} decim=${m.decimStage}`,
              center_freq: String(m.tunedHz ?? this.pendingCenterHz ?? 0),
              bandwidth:   String(this.outputRate),
              sample_rate: String(this.outputRate),
            };
            if (audioRate != null) kv.audio_rate = String(audioRate);
            this.h.onMessage?.(kv);
            // Apply pending tune/gain now that the bridge is up.
            if (firstHello) {
              if (this.pendingCenterHz   != null) {
                this.serverCenterHz = this.pendingCenterHz;
                this.sendJson({ t: 'freq', hz: this.pendingCenterHz });
              }
              if (this.pendingGainIdx    != null) this.sendJson({ t: 'gain', idx: this.pendingGainIdx });
              if (this.pendingMode       != null) this.sendJson({ t: 'mode', mode: this.pendingMode });
              if (this.pendingBwHz       != null) this.sendJson({ t: 'bw',   hz: this.pendingBwHz });
              if (this.pendingStreamMode != null) this.sendJson({ t: 'stream', mode: this.pendingStreamMode });
              if (this.pendingPass       != null) this.sendJson({ t: 'pass', lo: this.pendingPass.lo, hi: this.pendingPass.hi });
              if (this.pendingTaps       != null) this.sendJson({ t: 'taps', n: this.pendingTaps });
              if (this.pendingAgc        != null) this.sendJson({ t: 'agc', profile: this.pendingAgc });
              if (this.pendingFixedGain  != null) this.sendJson({ t: 'fgain', g: this.pendingFixedGain });
            }
            return;
          }
          if (m.t === 'status') {
            this.h.onMessage?.({ _debug: `spyserver ${m.msg}` });
            return;
          }
        } catch { /* ignore parse errors */ }
        return;
      }
      // Binary frame = 1-byte type tag + payload. The bridge tags each
      // frame so we can demux IQ / audio / FFT into different sinks.
      const ab = e.data as ArrayBuffer;
      if (!ab || ab.byteLength < 1) return;
      const u8 = new Uint8Array(ab);
      const payload = u8.subarray(1);
      switch (u8[0]) {
        case TAG_IQ:    this.h.onIq?.(payload); break;
        case TAG_AUDIO: this.h.onAudio?.(payload); break;
        case TAG_FFT:   this.h.onFft?.(payload); break;
        default:        /* unknown tag, drop */ break;
      }
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.h.onError?.(new Error('spyserver ws error'));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.h.onStatus?.({ connected: false });
      this.h.onClose?.();
      this.ws = null;
    };
  }

  /** Centre frequency in kHz (matches Kiwi / OWRX / rtl_tcp clients).
   *
   *  Decoupled model: the SpyServer stays tuned at `serverCenterHz`
   *  while the dial moves within the visible IQ window. Tuning is
   *  applied via csdr's `shift_addition_cc --fifo` control — no
   *  pipeline rebuild, no SpyServer retune, no audio gap. Only when
   *  the dial walks outside ±47 % of the IQ window do we actually
   *  re-anchor the SpyServer at the new dial (and reset shift to 0).
   *
   *  This is the same approach OpenWebRX uses, confirmed against the
   *  ha7ilm/csdr source (shift_addition_cc reads "%g\n" lines from
   *  the fifo at runtime — csdr.c:887). */
  setFreqKHz(kHz: number): void {
    const hz = Math.round(kHz * 1000);
    this.pendingCenterHz = hz;
    if (!this.gotHello) return;
    const halfWindow = (this.outputRate || 12000) * 0.47;
    let shiftHz: number;
    if (this.serverCenterHz && Math.abs(hz - this.serverCenterHz) < halfWindow) {
      // Dial within window — keep server tune, demod via csdr shift.
      shiftHz = hz - this.serverCenterHz;
    } else {
      // Walked outside window — re-anchor at new dial, shift back to 0.
      this.serverCenterHz = hz;
      this.sendJson({ t: 'freq', hz });
      shiftHz = 0;
    }
    this.sendJson({ t: 'shift', hz: shiftHz });
  }

  /** The frequency the upstream SpyServer is currently tuned to (the
   *  centre of the IQ stream). Returns 0 until we've actually sent a
   *  freq command. */
  getServerCenterHz(): number { return this.serverCenterHz; }

  setGainIndex(idx: number): void {
    this.pendingGainIdx = Math.max(0, Math.round(idx));
    if (this.gotHello) this.sendJson({ t: 'gain', idx: this.pendingGainIdx });
  }

  /** Demod mode passthrough — 'am' / 'usb' / 'lsb' / 'cw' / 'nbfm' /
   *  'wfm'. Sent as a 'mode' JSON command; the bridge maps it to the
   *  SpyServer demod enum and applies SETTING_AUDIO_DEMOD_MODE. */
  setSpyMode(mode: string): void {
    this.pendingMode = mode;
    if (this.gotHello) this.sendJson({ t: 'mode', mode });
  }

  /** Audio bandwidth in Hz — passband width for the server demod. */
  setBandwidthHz(hz: number): void {
    if (!Number.isFinite(hz) || hz <= 0) return;
    this.pendingBwHz = Math.round(hz);
    if (this.gotHello) this.sendJson({ t: 'bw', hz: this.pendingBwHz });
  }

  /** Toggle the SpyServer stream mode bitfield. Use one of
   *  SPY_STREAM_IQ / AUDIO / FFT (or a combination). */
  setSpyStreamMode(mode: number): void {
    this.pendingStreamMode = mode;
    if (this.gotHello) this.sendJson({ t: 'stream', mode });
  }

  /** Output sample rate the bridge is forwarding. 0 until hello arrives. */
  getOutputRate(): number { return this.outputRate; }

  /** Set bandpass FIR tap count — rebuilds the server-side csdr
   *  channel filter. Higher = sharper edges + better stopband. */
  setBandpassTaps(n: number): void {
    if (!Number.isFinite(n) || n < 50) return;
    this.pendingTaps = Math.round(n);
    this.h.onMessage?.({ _debug: `spyserver setBandpassTaps n=${this.pendingTaps} sent=${this.gotHello}` });
    if (this.gotHello) this.sendJson({ t: 'taps', n: this.pendingTaps });
  }

  /** Set AGC profile on the server-side csdr pipeline. */
  setAgcProfile(profile: 'off' | 'fast' | 'med' | 'slow'): void {
    this.pendingAgc = profile;
    if (this.gotHello) this.sendJson({ t: 'agc', profile });
  }

  /** Set fixed post-demod gain (used when AGC is off). */
  setFixedGain(g: number): void {
    if (!Number.isFinite(g) || g <= 0) return;
    this.pendingFixedGain = g;
    if (this.gotHello) this.sendJson({ t: 'fgain', g });
  }

  private sendJson(obj: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  }

  close(): void {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  // ── Kiwi/OWRX-shaped surface for shell.ts ──
  connect(): void { /* WS opens in constructor */ }
  disconnect(): void { this.close(); }
  setTune(p: { mode?: string; freqKHz?: number; lowCutHz?: number; highCutHz?: number }): void {
    if (p.freqKHz != null) this.setFreqKHz(p.freqKHz);
    // Send passband BEFORE mode. Bridge.setMode triggers an immediate
    // csdr rebuild; bridge.setPassband only updates passLoHz/passHiHz
    // (its csdr rebuild is debounced 250 ms). Sending pass first means
    // the in-bridge passband state is already correct when setMode
    // fires its immediate rebuild — no buzzing transient from a mode/
    // passband mismatch (e.g. mode=lsb against USB-side cutoffs).
    if (p.lowCutHz != null && p.highCutHz != null) {
      this.setPassband(p.lowCutHz, p.highCutHz);
    }
    if (p.mode != null) this.setSpyMode(p.mode);
  }
  setMode(mode: string): void { this.setSpyMode(mode); }
  setPassband(lo: number, hi: number): void {
    // Send both the bandwidth (drives IQ-rate decim on the bridge)
    // AND the signed lo/hi cutoffs (drive the csdr bandpass). Without
    // the second message the audio filter would stay at the hardcoded
    // mode default and the BW knob would feel like a no-op.
    this.setBandwidthHz(Math.max(100, hi - lo));
    if (this.gotHello) this.sendJson({ t: 'pass', lo, hi });
    else this.pendingPass = { lo, hi };
  }
  setSquelch(_db: number): void { /* client-side gate in player */ }
  setNoiseBlanker(_algo: number): void { /* none on spyserver IQ-mode */ }
  setNoiseReduction(_mode: number | boolean): void { /* none */ }
  /** Switch the server-side csdr audio AGC profile. 'off' drops the
   *  agc_ff stage entirely (output is a fixed-gain demod — useful
   *  when the RF gain is being driven manually). 'fast' / 'med' /
   *  'slow' set csdr's hardcoded profiles. */
  setAgcMode(mode: 'fast' | 'med' | 'slow' | 'off', manGain = 50): void {
    // Always send the AGC profile so csdr's pipeline rebuilds with
    // the new audio-AGC behaviour.
    if (this.gotHello) this.sendJson({ t: 'agc', profile: mode });
    // Drive the RF gain in tandem — most devices benefit from a
    // moderate gain default when AGC is engaged, and the manual
    // value when AGC is off.
    this.applyManGain(manGain, mode === 'off');
  }
  setAdpcm(_on: boolean): void { /* no ADPCM */ }
  /** Tuner gain — map the shell's manGain (0..120) to a SpyServer
   *  gain index. Called on every RF-knob movement when shell-side
   *  AGC is 'off'. We deliberately DO NOT touch csdr's AGC profile
   *  here — that's the job of setAgcMode. Conflating the two caused
   *  the pipeline to thrash between AGC-off and AGC-on every knob
   *  movement, killing audio. */
  setAgc(_on: boolean, manGain = 50): void {
    this.applyManGain(manGain, true);
  }

  /** Scale a 0..120 shell knob to a SpyServer gain index. Use the
   *  device's reported maxGain when known, otherwise fall back to 30
   *  — which is a safe default covering R2/Mini and one that earlier
   *  versions used unconditionally. Sending the setting on HF+ (which
   *  reports maxGain=0) is harmless if the device ignores it. */
  private applyManGain(manGain: number, _manual: boolean): void {
    void _manual;
    const top = this.maxGain > 0 ? this.maxGain : 30;
    const idx = Math.round((Math.max(0, Math.min(120, manGain)) / 120) * top);
    this.setGainIndex(idx);
  }
  setZoom(_zoom: number, centerKHz: number): void { this.setFreqKHz(centerKHz); }
  wfPaused = false;
  wfSpeed = 2;
  setWfSpeed(_n: number): void { /* no-op */ }
  pauseWaterfall(): void { /* no-op */ }
  resumeWaterfall(): void { /* no-op */ }
  getUsers(cb: (users: never[]) => void): void { cb([]); }
  adpcmRequested = false;
}
