import { buildUrls, parseFrame, URL_PREFIXES } from './protocol';
import type { KiwiHandlers, KiwiStatus, Mode, TuneParams } from './types';

/** A single connected-user record, parsed from a `SET GET_USERS`
 *  reply. Empty strings stand in for omitted fields. */
export interface KiwiUser {
  slot: number;
  name: string;
  geo: string;
  freqKHz: number | null;
  mode: string;
  ext: string;
  idleSec: number | null;
}

/** Decode a Kiwi `user_cb=<json>` payload into structured records.
 *  Modern Kiwi firmware encodes the user list as a JSON array; one
 *  entry per slot. Occupied slots carry `n` (name) plus optional
 *  `g`/`f`/`m`/`e`/`t` fields; empty slots are bare `{i:idx}` and are
 *  filtered out. URL-decoded value goes in. */
export function parseKiwiUsers(userCbJson: string): KiwiUser[] {
  let arr: unknown;
  try { arr = JSON.parse(userCbJson); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: KiwiUser[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const u = e as { i?: number; n?: string; g?: string; f?: number; m?: string; e?: string; t?: number };
    // Kiwi marks empty slots by omitting the name (`n`) field.
    if (u.n == null || u.n === '') continue;
    out.push({
      slot:    typeof u.i === 'number' ? u.i : out.length,
      name:    String(u.n),
      geo:     u.g ?? '',
      freqKHz: typeof u.f === 'number' && Number.isFinite(u.f) ? u.f : null,
      mode:    u.m ?? '',
      ext:     u.e ?? '',
      idleSec: typeof u.t === 'number' && Number.isFinite(u.t) ? u.t : null,
    });
  }
  return out;
}

export interface KiwiClientOptions {
  host: string;
  port: number;
  secure?: boolean;
  /** Identity sent to the Kiwi for its user list. */
  ident?: string;
  /** Free-form geo string (city, country) shown next to the user name
   *  in the server's online-users list. */
  geoLocation?: string;
  /** Optional password (Kiwi default = empty). */
  password?: string;
  /** Output sample rate we want the Kiwi to deliver (12000 is native). */
  audioOutRate?: number;
}

const DEFAULT_TUNE: TuneParams = {
  mode: 'lsb',
  freqKHz: 7200,
  lowCutHz: -2700,
  highCutHz: -300,
};

/** KiwiSDR client speaking the undocumented ws protocol used by kiwiclient.
 *  Two sockets: SND (audio + control) and W/F (waterfall). */
export class KiwiClient {
  private snd: WebSocket | null = null;
  private wf: WebSocket | null = null;
  private status: KiwiStatus = { connected: false };
  private keepalive: number | null = null;
  private tune: TuneParams = { ...DEFAULT_TUNE };
  private zoom = 8;
  private prefixIdx = 0;
  private opened = { snd: false, wf: false };
  private binDumpRemaining = { snd: 4, wf: 4 };
  private rxChan = 0;
  private wantConnected = false;
  private reconnectTimer: number | null = null;
  private shortSessions = 0;        // historical: kept for connect() reset
  private lastConnectedAt = 0;

  constructor(private opts: KiwiClientOptions, private h: KiwiHandlers = {}) {}

  connect(): void {
    this.wantConnected = true;
    this.shortSessions = 0;
    this.prefixIdx = 0;
    this.opened = { snd: false, wf: false };
    this.binDumpRemaining = { snd: 4, wf: 4 };
    this.lastConnectedAt = Date.now();
    this.preflightThenOpen();
  }

  /** GET /status from the Kiwi over our HTTP proxy. If the kiwi is full,
   *  password-protected (and we have none), or marked down, refuse to
   *  open the WS — that turns "instant 1005" into a clear error.
   *  Falls through on any preflight failure: the WS path can still
   *  succeed (e.g. on a kiwi blocking /status but not WS). */
  private async preflightThenOpen(): Promise<void> {
    try {
      const r = await fetch(`/api/kiwi-status?host=${encodeURIComponent(this.opts.host)}&port=${this.opts.port}`,
                            { cache: 'no-store' });
      // User may have hit power-off while preflight was in flight — bail
      // before opening any WebSocket.
      if (!this.wantConnected) return;
      if (r.ok) {
        const s = await r.json() as {
          ok: boolean; users: number | null; usersMax: number | null;
          chanNoPwd: number | null; passwordRequired: boolean;
          down: boolean; limitsEnabled?: boolean;
          version: string | null; name: string | null;
        };
        this.h.onMessage?.({ _debug: `preflight: users=${s.users}/${s.usersMax} chan_no_pwd=${s.chanNoPwd} passwd=${s.passwordRequired} down=${s.down} limits=${!!s.limitsEnabled} v=${s.version}` });
        // Surface the limits flag through onMessage so the diag chip
        // can decode it without us having to widen the KiwiStatus type.
        if (s.limitsEnabled) this.h.onMessage?.({ kiwi_limits_enabled: '1' });
        if (s.down) {
          this.permanentRefusal('kiwi reports down=1 — not opening WS');
          return;
        }
        if (s.passwordRequired && (this.opts.password == null || this.opts.password === '#')) {
          this.permanentRefusal('kiwi requires a password — none configured');
          return;
        }
        if (s.usersMax != null && s.users != null && s.users >= s.usersMax) {
          // Soft block: schedule a longer retry instead of permanent refusal.
          this.h.onMessage?.({ _debug: `kiwi full (${s.users}/${s.usersMax}) — backing off before retry` });
          this.shortSessions = Math.max(this.shortSessions, 3);
          this.scheduleReconnect();
          return;
        }
        if (s.chanNoPwd === 0 && (this.opts.password == null || this.opts.password === '#')) {
          this.permanentRefusal('kiwi has no public slots (chan_no_pwd=0); password required');
          return;
        }
      }
    } catch {
      // Preflight failures aren't fatal — fall through to WS attempt.
    }
    if (!this.wantConnected) return;
    // Establish an HTTP session footprint with the kiwi before opening
    // the WS. v1.817+ kiwis silently refuse to start the audio loop for
    // WS clients that haven't first GET'd the web UI's assets — the
    // tell-tale symptom is `audio_init=0` forever and a 10-s kick. The
    // working Android app (which wraps the kiwi's own web UI) naturally
    // fetches these as part of page load.
    //
    // Routed through /api/kiwi-touch on our server so HTTPS pages can
    // touch the plain-HTTP kiwi without tripping the browser's mixed-
    // content blocker (which silently drops the requests otherwise —
    // the symptom on Android was: works on desktop dev HTTP, fails on
    // phone HTTPS).
    try {
      const h = encodeURIComponent(this.opts.host);
      const p = this.opts.port;
      await Promise.all([
        fetch(`/api/kiwi-touch?host=${h}&port=${p}&path=${encodeURIComponent('/')}`,                           { cache: 'no-store' }).catch(() => {}),
        fetch(`/api/kiwi-touch?host=${h}&port=${p}&path=${encodeURIComponent('/kiwi/kiwi_js_load.js')}`,       { cache: 'no-store' }).catch(() => {}),
        fetch(`/api/kiwi-touch?host=${h}&port=${p}&path=${encodeURIComponent('/config/config.js')}`,           { cache: 'no-store' }).catch(() => {}),
        fetch(`/api/kiwi-touch?host=${h}&port=${p}&path=${encodeURIComponent('/pkgs/js/sprintf/sprintf.js')}`, { cache: 'no-store' }).catch(() => {}),
      ]);
    } catch { /* ignored */ }
    if (!this.wantConnected) return;
    this.openWithPrefix();
  }

  private permanentRefusal(why: string): void {
    this.h.onMessage?.({ _debug: `refusing to connect: ${why}` });
    this.h.onError?.(new Error(`kiwi refused: ${why}`));
    this.wantConnected = false;
    this.update({ connected: false });
    this.h.onClose?.();
  }

  private openWithPrefix(): void {
    const prefix = URL_PREFIXES[this.prefixIdx];
    const { snd, wf } = buildUrls(this.opts.host, this.opts.port, this.opts.secure, prefix);
    this.snd = this.openSocket(snd, 'SND');
    // The working Android client (PCAP, May 2026) opens the W/F socket
    // ~110 ms after SND. Simultaneous opens look robotic to the v1.817+
    // bot detector and the W/F socket is the one kicked at 10 s. Delay
    // matches the observed gap.
    setTimeout(() => {
      if (this.wantConnected) this.wf = this.openSocket(wf, 'W/F');
    }, 150);
  }

  private scheduleReconnect(): void {
    // No automatic reconnect: when the kiwi drops us, just stay
    // disconnected. The operator picks the next move (power-cycle, try
    // another receiver, etc.). This avoids hammering kiwis with strict
    // time limits and the `badp` IP-lockout spiral that came with it.
    const sessionMs = this.lastConnectedAt ? Date.now() - this.lastConnectedAt : 0;
    this.h.onMessage?.({ _debug: `kiwi closed after ${sessionMs}ms — auto-reconnect disabled; tap power to retry` });
    this.wantConnected = false;
  }

  private tryFallback(): boolean {
    if (this.opened.snd || this.opened.wf) return false;
    if (this.prefixIdx + 1 >= URL_PREFIXES.length) return false;
    this.prefixIdx++;
    this.h.onMessage?.({ _debug: `falling back to prefix "${URL_PREFIXES[this.prefixIdx]}"` });
    this.openWithPrefix();
    return true;
  }

  disconnect(): void {
    this.wantConnected = false;
    if (this.reconnectTimer != null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
    this.snd?.close(); this.wf?.close();
    this.snd = null; this.wf = null;
    this.update({ connected: false });
  }

  setTune(p: Partial<TuneParams>): void {
    this.tune = { ...this.tune, ...p };
    this.send(this.snd,
      `SET mod=${this.tune.mode.toUpperCase()} low_cut=${this.tune.lowCutHz} high_cut=${this.tune.highCutHz} freq=${this.tune.freqKHz}`);
  }

  setMode(mode: Mode): void { this.setTune({ mode }); }
  setFreqKHz(freqKHz: number): void { this.setTune({ freqKHz }); }
  setPassband(lowCutHz: number, highCutHz: number): void { this.setTune({ lowCutHz, highCutHz }); }

  /** Set the waterfall zoom and visible-window center frequency (in kHz). */
  setZoom(zoom: number, centerKHz: number): void {
    this.zoom = zoom;
    this.send(this.wf, `SET zoom=${zoom} cf=${centerKHz.toFixed(6)}`);
    // Re-assert wf_speed after each zoom change — without this the server
    // tends to drift to a slower rate at high zoom levels.
    this.send(this.wf, `SET wf_speed=${this.wfSpeed}`);
  }

  setAgc(on: boolean, manGain = 50): void {
    this.send(this.snd,
      `SET agc=${on ? 1 : 0} hang=0 thresh=-100 slope=6 decay=1000 manGain=${manGain}`);
  }

  /** Coarse AGC mode selector — wraps `setAgc` with sensible defaults
   *  per mode (decay time + manual gain). 'off' falls back to manual
   *  gain ≈ S5 reference. */
  setAgcMode(mode: 'fast' | 'med' | 'slow' | 'off', manGain = 50): void {
    if (mode === 'off') {
      this.setAgc(false, manGain);
      return;
    }
    const decay = mode === 'fast' ? 100 : mode === 'slow' ? 4000 : 1000;
    this.send(this.snd,
      `SET agc=1 hang=0 thresh=-100 slope=6 decay=${decay} manGain=50`);
  }

  /** Antenna-switch extension: select slot 1..N. Server must allow switching
   *  (`antsw_AntennaDenySwitching=0`) and have the slot wired. */
  setAntenna(slot: number): void {
    this.send(this.snd, `SET ant=g${slot}`);
  }

  /** Toggle the Kiwi server-side ADPCM compression. When enabled, audio frames
   *  arrive at half the bandwidth and we decode them client-side. */
  setAdpcm(on: boolean): void {
    this.adpcmRequested = on;
    this.send(this.snd, `SET compression=${on ? 1 : 0}`);
  }
  /** Read by the SND frame parser to classify each frame definitively. */
  adpcmRequested = false;

  /** Set noise-blanker algorithm. 0=off, 1=std, 2=auto, 3=Wild's. */
  setNoiseBlanker(algo: number): void {
    this.send(this.snd, `SET nb algo=${algo}`);
  }

  /** Waterfall update rate / averaging. 0=off, 1=1fps, 2=slow, 3=med, 4=fast. */
  wfSpeed = 2;
  setWfSpeed(n: number): void {
    this.wfSpeed = Math.max(0, Math.min(4, Math.round(n)));
    if (!this.wfPaused) this.send(this.wf, `SET wf_speed=${this.wfSpeed}`);
  }
  /** Transient WF pause — used by the shell when a decoder or audio
   *  spectrogram is open to stop the waterfall stream without losing
   *  the user's chosen wfSpeed. Sends wf_speed=0 while paused, restores
   *  the stored wfSpeed on resume. */
  wfPaused = false;
  pauseWaterfall(): void {
    if (this.wfPaused) return;
    this.wfPaused = true;
    this.send(this.wf, `SET wf_speed=0`);
  }
  resumeWaterfall(): void {
    if (!this.wfPaused) return;
    this.wfPaused = false;
    this.send(this.wf, `SET wf_speed=${this.wfSpeed}`);
  }

  /** Toggle server-side noise reduction. Captured exactly from QiwiQ — the
   *  active algorithm is 3 (not 1), and both denoiser types need their full
   *  parameter set + en=1 before audible effect kicks in. */
  setNoiseReduction(on: boolean): void {
    if (!on) { this.send(this.snd, 'SET nr algo=0'); return; }
    this.send(this.snd, 'SET nr algo=3');
    for (const type of [0, 1]) {
      this.send(this.snd, `SET nr type=${type} param=0 pval=1`);
      this.send(this.snd, `SET nr type=${type} param=1 pval=0.95`);
      this.send(this.snd, `SET nr type=${type} param=2 pval=100`);
      this.send(this.snd, `SET nr type=${type} param=3 pval=0`);
      this.send(this.snd, `SET nr type=${type} en=1`);
    }
  }

  setSquelch(db: number): void {
    // Kiwi protocol: `SET squelch=THRESHOLD param=TAIL`.
    // Threshold semantics depend on the active demod:
    //   • AM/AMN/FM/NBFM/SAM — absolute dBm threshold; signal is muted
    //     when sMeter_dBm < threshold. Real signals run -110..-30 dBm,
    //     so the knob value is mapped to -110..-71 dBm here.
    //   • SSB/LSB/USB/CW — interpreted as dB above the noise floor;
    //     signal is muted when SNR < threshold. Sent verbatim.
    // 0 always means "off" regardless of mode.
    const v = Math.max(0, db | 0);
    let thresh: number;
    if (v === 0) {
      thresh = 0;
    } else {
      const m = this.tune.mode;
      const carrierMode = m === 'am' || m === 'amn' || m === 'sam' ||
                          m === 'nbfm' || m === 'drm';
      thresh = carrierMode ? (-111 + v) : v;
    }
    this.send(this.snd, `SET squelch=${thresh} param=0.20`);
  }

  /* ───────── internals ───────── */

  private openSocket(url: string, kind: 'SND' | 'W/F'): WebSocket {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.h.onMessage?.({ _debug: `opening ${kind} ${url}` });
    let openedAt = 0;
    ws.onopen = () => {
      openedAt = performance.now();
      // Mark the moment the SND socket comes up — the audio stream really
      // "starts" from here. Reconnect timing measures from this.
      if (kind === 'SND') {
        this.opened.snd = true;
        this.lastConnectedAt = Date.now();
      } else {
        this.opened.wf = true;
      }
      this.onOpen(ws, kind);
    };
    ws.onmessage = (ev) => this.onMessage(kind, ev.data);
    ws.onerror = () => this.h.onError?.(new Error(`${kind} socket error (url=${url})`));
    ws.onclose = (ev) => {
      const lifeMs = openedAt ? Math.round(performance.now() - openedAt) : 0;
      this.h.onError?.(new Error(`${kind} closed after ${lifeMs}ms code=${ev.code} reason="${ev.reason}" clean=${ev.wasClean}`));
      // If one socket drops, kill the other so we always reconnect as a pair.
      const other = kind === 'SND' ? this.wf : this.snd;
      if (other && other.readyState <= WebSocket.OPEN) {
        try { other.close(); } catch {}
      }
      this.update({ connected: false });
      if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
      if (this.tryFallback()) return;
      this.h.onClose?.();
      // wantConnected is the source of truth; user-initiated disconnect()
      // already clears it, so anything else is unexpected and should retry.
      if (this.wantConnected) this.scheduleReconnect();
    };
    return ws;
  }

  private onOpen(ws: WebSocket, kind: 'SND' | 'W/F'): void {
    // Send every command as a binary WS frame — the kiwi v1.817+ bot
    // detector kicks clients sending TEXT frames. PCAP capture from a
    // known-working app confirms BINARY-only.
    const send = (cmd: string) => ws.send(KiwiClient.encoder.encode(cmd));
    // SET auth MUST be the first command — anything before it counts as a
    // bad-password attempt on this firmware (badp counter; locks the IP
    // after ~5 attempts and kicks new connections with code=1006).
    // QiwiQ uses "p=#" rather than empty.
    const pwd = this.opts.password ?? '#';
    send(`SET auth t=kiwi p=${pwd}`);


    const ident = encodeURIComponent(this.opts.ident ?? 'radiom');
    if (kind === 'SND') {
      // Init sequence reverse-engineered byte-for-byte from a working
      // Android client (PCAP capture, May 2026). The v1.817+ bot detector
      // is sensitive to:
      //  • SET AR OK *before* SET ident_user (not after)
      //  • squelch=0 param=0.20 (NOT max=0)
      //  • uppercase SET mod=USB/LSB (NOT lowercase)
      //  • SET STATS_UPD ch=N *right after* SET mod (with current channel)
      //  • no SET geoloc, no SET lms_autonotch, no SET GET_USERS
      // Any deviation gets us flagged → audio_init stays 0 → 10 s kick.
      const out = this.opts.audioOutRate ?? 48000;
      send(`SET AR OK in=12000 out=${out}`);
      send(`SET ident_user=${ident}`);
      send('SET squelch=0 param=0.20');
      send('SET compression=0');
      send('SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50');
      send('SET nb algo=1');
      send('SET nb type=0 param=0 pval=100');
      send('SET nb type=0 param=1 pval=50');
      send('SET nb type=0 en=1');
      send('SET nb type=1 en=1');
      send('SET nb type=2 en=0');
      send('SET nr algo=0');
      send(`SET mod=${this.tune.mode.toUpperCase()} low_cut=${this.tune.lowCutHz} high_cut=${this.tune.highCutHz} freq=${this.tune.freqKHz}`);
      send(`SET STATS_UPD ch=${this.rxChan}`);
      send('SET keepalive');
      // Periodic keepalive on BOTH sockets every ~5 s. The kiwi protocol
      // requires periodic activity to keep long sessions alive — without
      // it the connection drops after ~30 s once the bot-detection
      // window passes and other inactivity timers kick in. The bot
      // detector itself only checks the first 10 s, so adding periodic
      // `SET keepalive` after that point doesn't trip it.
      if (!this.keepalive) {
        this.keepalive = setInterval(() => {
          this.send(this.snd, 'SET keepalive');
          this.send(this.wf, 'SET keepalive');
        }, 5_000) as unknown as number;
      }
      this.update({ connected: true });
    } else {
      // W/F init sequence — byte-for-byte from working Android PCAP.
      // Note: ident_user comes *after* the WF config, not before.
      // mindb=-91 (not -111) matches the working client.
      send(`SET zoom=${this.zoom} cf=${this.tune.freqKHz.toFixed(6)}`);
      send('SET maxdb=-30 mindb=-91');
      send('SET wf_comp=0');
      send(`SET wf_speed=${this.wfSpeed}`);
      send(`SET ident_user=${ident}`);
      send('SET keepalive');
    }
  }

  /** Request the server's online-users list. The callback fires once
   *  with the parsed user array on the next matching text frame, then
   *  is cleared. Server replies on the SND socket. */
  getUsers(cb: (users: KiwiUser[]) => void): void {
    this.usersCb = cb;
    this.send(this.snd, 'SET GET_USERS');
  }

  private usersCb: ((users: KiwiUser[]) => void) | null = null;

  private onMessage(kind: 'SND' | 'W/F', data: unknown): void {
    if (typeof data === 'string') {
      this.h.onMessage?.({ _debug: `${kind} text frame: ${data.slice(0, 200)}` });
      this.handleMsgText(data);
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    // (was: reset reconnect counter; auto-reconnect is now off entirely)

    const slot = kind === 'SND' ? 'snd' : 'wf';
    if (this.binDumpRemaining[slot] > 0) {
      const u = new Uint8Array(data);
      const tag3 = String.fromCharCode(u[0] || 0, u[1] || 0, u[2] || 0);
      const head = Array.from(u.subarray(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      this.h.onMessage?.({ _debug: `${kind} bin len=${u.length} tag3="${tag3}" head=${head}` });
      this.binDumpRemaining[slot]--;
    }

    const f = parseFrame(data);
    if (f.tag === 'MSG') {
      this.handleMsgKv(f.kv);
    } else if (f.tag === 'SND') {
      if (kind === 'SND') {
        // Authoritative ADPCM flag — derived from what we requested rather
        // than the unreliable payload-size heuristic in parseFrame.
        f.audio.adpcm = this.adpcmRequested;
        this.h.onAudio?.(f.audio);
      }
    } else if (f.tag === 'W/F') {
      if (kind === 'W/F') this.h.onWaterfall?.(f.wf);
    }
  }

  private handleMsgText(text: string): void {
    const kv: Record<string, string> = {};
    for (const part of text.split(' ')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq < 0) { kv[part] = ''; continue; }
      kv[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    }
    this.handleMsgKv(kv);
  }

  private handleMsgKv(kv: Record<string, string>): void {
    this.h.onMessage?.(kv);
    // One-shot user-list response: modern Kiwi firmware emits `user_cb`
    // as a JSON-array string. The keepalive loop also fetches this every
    // ~5 s so getUsers() callers usually return on the very next frame
    // without an explicit re-request.
    if (this.usersCb && kv.user_cb && kv.user_cb.startsWith('[')) {
      const cb = this.usersCb;
      this.usersCb = null;
      cb(parseKiwiUsers(kv.user_cb));
    }
    if (kv.rx_chan != null) {
      const ch = +kv.rx_chan;
      if (Number.isFinite(ch) && ch !== this.rxChan) {
        this.rxChan = ch;
        this.send(this.snd, `SET STATS_UPD ch=${ch}`);
        // Critical: the kiwi only starts the audio loop after it has
        // assigned us rx_chan AND received SET mod= against that channel.
        // Without this re-assert, audio_init stays 0 forever and the
        // kiwi tears down the connection at ~80 s. PCAP from working
        // client confirms a re-send of SET mod= ~5 ms after rx_chan
        // arrives. SET STATS_UPD ch=N must come first; both are needed.
        this.send(this.snd,
          `SET mod=${this.tune.mode.toUpperCase()} low_cut=${this.tune.lowCutHz} high_cut=${this.tune.highCutHz} freq=${this.tune.freqKHz}`);
      }
    }
    const u: Partial<KiwiStatus> = {};
    if (kv.audio_rate) u.audioRate = +kv.audio_rate;
    if (kv.sample_rate) u.sampleRate = +kv.sample_rate;
    if (kv.center_freq) u.centerFreq = +kv.center_freq;
    if (kv.bandwidth) u.bandwidth = +kv.bandwidth;
    if (kv.version_maj && kv.version_min) u.version = `${kv.version_maj}.${kv.version_min}`;
    if (kv.MSG) u.message = kv.MSG;
    if (Object.keys(u).length) this.update(u);
  }

  private update(patch: Partial<KiwiStatus>): void {
    this.status = { ...this.status, ...patch };
    this.h.onStatus?.(this.status);
  }

  /** Encode the command as a UTF-8 binary WebSocket frame. The KiwiSDR
   *  protocol uses binary frames for *all* SET commands (PCAP confirms).
   *  The v1.817+ bot detector flags clients sending TEXT frames as
   *  non-canonical and kicks them at 10 s. */
  private static encoder = new TextEncoder();
  private send(ws: WebSocket | null, cmd: string): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(KiwiClient.encoder.encode(cmd));
  }
}
