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
}

export interface SpyServerHandlers {
  onMessage?: (kv: Record<string, string>) => void;
  onIq?: (iqBytes: Uint8Array) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
  onStatus?: (s: { connected: boolean }) => void;
}

export class SpyServerClient {
  private ws: WebSocket | null = null;
  private opts: SpyServerClientOpts;
  private h: SpyServerHandlers;
  private gotHello = false;
  private pendingCenterHz: number | null;
  private pendingGainIdx:  number | null;
  /** Output sample rate reported by the bridge in its hello message.
   *  Set when the JSON hello arrives; consumed by external callers
   *  through `getOutputRate()`. */
  private outputRate = 0;

  constructor(opts: SpyServerClientOpts, handlers: SpyServerHandlers) {
    this.opts = opts;
    this.h = handlers;
    this.pendingCenterHz = opts.centerHz ?? null;
    this.pendingGainIdx  = opts.gainIdx ?? null;
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
            this.gotHello = true;
            this.outputRate = Math.max(1, Math.round(+m.srOut || 0));
            this.h.onStatus?.({ connected: true });
            const kv: Record<string, string> = {
              _debug: `spyserver hello device=${m.device} srOut=${m.srOut} range=${m.minHz}..${m.maxHz} maxGain=${m.maxGain} decim=${m.decimStage}`,
              center_freq: String(m.tunedHz ?? this.pendingCenterHz ?? 0),
              bandwidth:   String(this.outputRate),
              audio_rate:  String(this.outputRate),
              sample_rate: String(this.outputRate),
            };
            this.h.onMessage?.(kv);
            // Apply pending tune/gain now that the bridge is up.
            if (this.pendingCenterHz != null) this.sendJson({ t: 'freq', hz: this.pendingCenterHz });
            if (this.pendingGainIdx  != null) this.sendJson({ t: 'gain', idx: this.pendingGainIdx });
            return;
          }
          if (m.t === 'status') {
            this.h.onMessage?.({ _debug: `spyserver ${m.msg}` });
            return;
          }
        } catch { /* ignore parse errors */ }
        return;
      }
      // Binary frame = int16 LE IQ pairs at `srOut`. Same shape as the
      // rtl_tcp bridge's output, consumed identically.
      const ab = e.data as ArrayBuffer;
      if (ab && ab.byteLength) this.h.onIq?.(new Uint8Array(ab));
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

  /** Centre frequency in kHz (matches Kiwi / OWRX / rtl_tcp clients). */
  setFreqKHz(kHz: number): void {
    const hz = Math.round(kHz * 1000);
    this.pendingCenterHz = hz;
    if (this.gotHello) this.sendJson({ t: 'freq', hz });
  }

  setGainIndex(idx: number): void {
    this.pendingGainIdx = Math.max(0, Math.round(idx));
    if (this.gotHello) this.sendJson({ t: 'gain', idx: this.pendingGainIdx });
  }

  /** Output sample rate the bridge is forwarding. 0 until hello arrives. */
  getOutputRate(): number { return this.outputRate; }

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
  }
  setMode(_mode: string): void { /* demod is client-side */ }
  setPassband(_lo: number, _hi: number): void { /* demod is client-side */ }
  setSquelch(_db: number): void { /* client-side gate in player */ }
  setNoiseBlanker(_algo: number): void { /* none on spyserver IQ-mode */ }
  setNoiseReduction(_mode: number | boolean): void { /* none */ }
  setAgcMode(_mode: 'fast' | 'med' | 'slow' | 'off', _manGain = 50): void { /* none */ }
  setAdpcm(_on: boolean): void { /* no ADPCM */ }
  /** Tuner gain — map AGC's manGain (0..120) to a SpyServer gain
   *  index. Bridge clamps and forwards. */
  setAgc(on: boolean, manGain = 50): void {
    if (on) return;             // SpyServer manages its own AGC server-side
    this.setGainIndex(Math.round((manGain / 120) * 30));   // 0..30 covers most devices
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
