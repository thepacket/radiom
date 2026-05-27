// Copyright (c) Andre Paquette
//
// rtl_tcp client — speaks the radiom-proxied WS form
// (/ws/rtltcp/<host>:<port>) and surfaces samples through the same
// player-side hooks the KiwiSDR and OpenWebRX clients use.
//
// rtl_tcp is **IQ-only** by design — there's no server-side demod.
// To play audible audio the operator picks a demod mode (LSB, NBFM,
// etc.) and the browser does the demod on the decimated IQ stream.
// For now this client just emits raw IQ via `onIq`; client-side
// demod lives elsewhere (the existing ISB / SSBf / IQ-audio paths
// can consume it).

export interface RtlTcpClientOpts {
  /** rtl_tcp host:port — e.g. "192.168.1.50:1234". */
  url: string;
  /** Tuner-side sample rate. Default 2048000 (2.048 MS/s). */
  inputRate?: number;
  /** Output (post-decimation) sample rate. Default 250000 (250 kS/s). */
  outRate?: number;
  /** Initial centre frequency in Hz. Defaults to 100 MHz so the
   *  receiver lands somewhere intelligible on FM broadcast for testing. */
  centerHz?: number;
}

export interface RtlTcpHandlers {
  onMessage?: (kv: Record<string, string>) => void;
  onIq?: (iqBytes: Uint8Array) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
  onStatus?: (s: { connected: boolean }) => void;
}

export class RtlTcpClient {
  private ws: WebSocket | null = null;
  private opts: RtlTcpClientOpts;
  private h: RtlTcpHandlers;
  private gotHello = false;
  private pendingCenterHz: number | null;
  private pendingRate:    number | null;

  constructor(opts: RtlTcpClientOpts, handlers: RtlTcpHandlers) {
    this.opts = opts;
    this.h = handlers;
    this.pendingCenterHz = opts.centerHz ?? 100_000_000;
    this.pendingRate = opts.inputRate ?? 2_048_000;
    this.open();
  }

  private wsUrl(): string {
    // The opts.url is host:port — translate to the proxy form.
    const m = this.opts.url.match(/^([\w.-]+):(\d+)$/);
    if (!m) throw new Error(`bad rtl_tcp URL: ${this.opts.url}`);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}/ws/rtltcp/${m[1]}:${m[2]}`;
  }

  private open(): void {
    let url: string;
    try { url = this.wsUrl(); } catch (e) { this.h.onError?.(e as Error); return; }
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.h.onStatus?.({ connected: true });
      this.h.onMessage?.({ _debug: `rtl_tcp connecting via ${url}` });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      if (typeof e.data === 'string') {
        try {
          const m = JSON.parse(e.data);
          if (m.t === 'hello') {
            this.gotHello = true;
            this.h.onMessage?.({
              _debug: `rtl_tcp hello tuner=${m.tunerType} gains=${m.gains} srIn=${m.srInput} srOut=${m.srOut}`,
              center_freq: String(this.pendingCenterHz ?? 0),
              bandwidth:   String(m.srOut ?? 0),
              audio_rate:  String(m.srOut ?? 0),
              sample_rate: String(m.srOut ?? 0),
            });
            // Apply any pending tune/rate now that the link is up.
            if (this.pendingRate != null)     this.sendJson({ t: 'rate', hz: this.pendingRate });
            if (this.pendingCenterHz != null) this.sendJson({ t: 'freq', hz: this.pendingCenterHz });
            // Default to manual gain at a reasonable mid-level until
            // the operator drives the RF knob.
            this.sendJson({ t: 'gainmode', manual: true });
            this.sendJson({ t: 'gain', tenthDb: 200 });    // 20 dB
            return;
          }
          if (m.t === 'status') {
            this.h.onMessage?.({ _debug: `rtl_tcp ${m.msg}` });
            return;
          }
        } catch {}
        return;
      }
      // Binary frame = int16 LE IQ samples at srOut. Forward verbatim
      // to the player's IQ pipeline — same shape as Kiwi IQ-mode.
      const ab = e.data as ArrayBuffer;
      if (ab && ab.byteLength) this.h.onIq?.(new Uint8Array(ab));
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.h.onError?.(new Error('rtl_tcp ws error'));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.h.onStatus?.({ connected: false });
      this.h.onClose?.();
      this.ws = null;
    };
  }

  /** Centre frequency in kHz (matches the units used elsewhere in
   *  the app — KiwiSDR / OWRX clients both take kHz). */
  setFreqKHz(kHz: number): void {
    const hz = Math.round(kHz * 1000);
    this.pendingCenterHz = hz;
    if (this.gotHello) this.sendJson({ t: 'freq', hz });
  }

  /** Tuner-side input rate (Hz). rtl_tcp will adjust the decimator
   *  accordingly. */
  setSampleRate(hz: number): void {
    this.pendingRate = hz;
    if (this.gotHello) this.sendJson({ t: 'rate', hz });
  }

  /** Manual tuner gain in tenths-of-dB (e.g. 200 = 20 dB). */
  setGain(tenthDb: number): void {
    this.sendJson({ t: 'gainmode', manual: true });
    this.sendJson({ t: 'gain', tenthDb });
  }

  /** rtl_tcp AGC (the tuner's own AGC, not a software one). Use this
   *  internally; the Kiwi-shaped public setAgc below repurposes the
   *  manual-gain arg into a tuner-gain set when off. */
  setRtlAgc(on: boolean): void { this.sendJson({ t: 'agc', on }); }
  setFreqCorrection(ppm: number): void { this.sendJson({ t: 'corr', ppm }); }
  setDirectSampling(mode: number): void { this.sendJson({ t: 'direct', mode }); }
  setOffsetTuning(on: boolean): void { this.sendJson({ t: 'offset', on }); }
  setOutRate(hz: number): void { this.sendJson({ t: 'decim', outHz: hz }); }
  /** Switch the bridge's WS-output sample format. Use 'uc8' for
   *  dump978 / dump1090 (with --iformat UC8), 'int16' for everything
   *  else (the default). */
  setOutFormat(fmt: 'uc8' | 'int16'): void { this.sendJson({ t: 'format', fmt }); }

  private sendJson(obj: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  close(): void {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  // ── Kiwi/OWRX-shaped surface so shell.ts can call this.client.X
  //    uniformly. Most are no-ops for rtl_tcp: it's a raw tuner, no
  //    server-side demod / squelch / NR / NB / AGC profile / wf-speed.
  //    Demod happens client-side downstream.
  connect(): void { /* WS opens in constructor */ }
  disconnect(): void { this.close(); }
  setTune(p: { mode?: string; freqKHz?: number; lowCutHz?: number; highCutHz?: number }): void {
    if (p.freqKHz != null) this.setFreqKHz(p.freqKHz);
  }
  setMode(_mode: string): void { /* demod is client-side */ }
  setPassband(_lo: number, _hi: number): void { /* demod is client-side */ }
  setSquelch(_db: number): void { /* client-side gate in player */ }
  setNoiseBlanker(_algo: number): void { /* none on rtl_tcp */ }
  setNoiseReduction(_mode: number | boolean): void { /* none on rtl_tcp */ }
  setAgcMode(_mode: 'fast' | 'med' | 'slow' | 'off', _manGain = 50): void { /* none */ }
  setAdpcm(_on: boolean): void { /* no ADPCM on rtl_tcp */ }
  /** Tuner gain — re-purpose AGC's manGain knob (0..120) as a
   *  tenths-of-dB tuner gain (0..480 ≈ 48 dB). */
  setAgc(on: boolean, manGain = 50): void {
    if (on) { this.setAgcMode('fast'); }
    else    { this.setGain(Math.round(manGain * 4)); }
  }
  setZoom(_zoom: number, centerKHz: number): void { this.setFreqKHz(centerKHz); }
  /** Waterfall speed: not configurable server-side on rtl_tcp. */
  wfPaused = false;
  wfSpeed = 2;
  setWfSpeed(_n: number): void { /* no-op */ }
  pauseWaterfall(): void { /* no-op */ }
  resumeWaterfall(): void { /* no-op */ }
  getUsers(cb: (users: never[]) => void): void { cb([]); }
  adpcmRequested = false;
}
