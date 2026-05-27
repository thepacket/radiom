// Copyright (c) Andre Paquette
//
// OpenWebRX (jketterl mainline) WebSocket client.
//
// Adapter shape: emits Kiwi-style AudioFrame and WaterfallFrame so the
// existing shell/player wiring works unchanged. The on-the-wire format
// is translated internally (LE int16 → BE int16 PCM, float32 dBFS bins →
// 0..255 mapped to -110..-10 dBm). Protocol reference lives in
// memory/openwebrx_protocol.md.
//
// Mainline limitations honoured here:
//   • No absolute-tune message — tuning across the SDR span requires a
//     selectprofile + wait for new center_freq. We send selectprofile
//     for the first profile that covers the requested freq; if none do,
//     setTune emits a status error.
//   • No raw IQ — only audio modes. HFDL/ISB stay Kiwi-only.

import type {
  AudioFrame, KiwiHandlers, KiwiStatus, Mode, TuneParams, WaterfallFrame,
} from '../kiwi/types';
import { AdpcmDecoder } from '../audio/adpcm';

/** Port of OpenWebRX's `ImaAdpcmCodec` (htdocs/lib/AudioEngine.js).
 *  Same step + index tables as the standard Intel/DVI variant the
 *  KiwiSDR codec uses, but the SYNC re-anchor + per-byte syncCounter
 *  + cross-frame `skip` field match the upstream reference exactly,
 *  which audibly improves quality vs the generic KiwiSDR ADPCM
 *  decoder (no predictor drift between SYNC markers, no boundary
 *  glitches across WS frames). */
const OWRX_STEP_TABLE = new Int16Array([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
  724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
  3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]);
const OWRX_INDEX_TABLE = new Int8Array([
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
]);

class OwrxImaAdpcmCodec {
  private predictor = 0;
  private stepIndex = 0;
  private step = OWRX_STEP_TABLE[0];
  private synchronized = 0;
  private syncCounter = 0;
  private skip = 0;

  reset(): void {
    this.predictor = 0;
    this.stepIndex = 0;
    this.step = OWRX_STEP_TABLE[0];
    this.synchronized = 0;
    this.syncCounter = 0;
    this.skip = 0;
  }
  // ASCII for "SYNC".
  private static readonly SYNC = [0x53, 0x59, 0x4e, 0x43];

  decodeWithSync(data: Uint8Array): Int16Array {
    const out = new Int16Array(data.length * 2);
    let index = this.skip;
    let oi = 0;
    while (index < data.length) {
      while (this.synchronized < 4 && index < data.length) {
        if (data[index] === OwrxImaAdpcmCodec.SYNC[this.synchronized]) {
          this.synchronized++;
        } else {
          this.synchronized = 0;
        }
        index++;
        if (this.synchronized === 4) {
          // Upstream uses strict `<` (not `<=`): if the state straddles
          // the WS-frame boundary, skip the state read entirely rather
          // than reading junk bytes. The `this.skip` field above
          // re-aligns the next call. Also DO NOT refresh `this.step`
          // here — upstream leaves it stale on purpose; refreshing
          // creates a one-sample diff vs the reference that has shown
          // up audibly on some streams.
          if (index + 4 < data.length) {
            const dv = new DataView(
              data.buffer, data.byteOffset + index, 4,
            );
            this.stepIndex = dv.getInt16(0, true);
            this.predictor = dv.getInt16(2, true);
          }
          this.syncCounter = 1000;
          index += 4;
          break;
        }
      }
      while (index < data.length) {
        if (this.syncCounter-- < 0) {
          this.synchronized = 0;
          break;
        }
        out[oi++] = this.decodeNibble(data[index] & 0x0f);
        out[oi++] = this.decodeNibble((data[index] >> 4) & 0x0f);
        index++;
      }
    }
    this.skip = index - data.length;
    return out.slice(0, oi);
  }

  private decodeNibble(nibble: number): number {
    this.stepIndex += OWRX_INDEX_TABLE[nibble];
    if (this.stepIndex < 0) this.stepIndex = 0;
    else if (this.stepIndex > 88) this.stepIndex = 88;
    let diff = this.step >> 3;
    if (nibble & 1) diff += this.step >> 2;
    if (nibble & 2) diff += this.step >> 1;
    if (nibble & 4) diff += this.step;
    if (nibble & 8) diff = -diff;
    let p = this.predictor + diff;
    if (p > 32767) p = 32767; else if (p < -32768) p = -32768;
    this.predictor = p;
    this.step = OWRX_STEP_TABLE[this.stepIndex];
    return this.predictor;
  }
}

export interface OpenWebRxClientOptions {
  /** Full URL including scheme and path, e.g. wss://host:port/ws/ */
  url: string;
  ident?: string;
  /** Override the requested output_rate. If omitted, the client picks
   *  a value that's a clean integer divisor of the AudioContext sample
   *  rate (when `ctxSampleRate` is provided), matching what the native
   *  OpenWebRX client does — avoids fractional resampling and the
   *  associated quality loss. */
  audioOutRate?: number;
  hdAudioOutRate?: number;
  /** AudioContext sample rate of the player. When set, the client
   *  requests an output_rate / hd_output_rate that divides evenly into
   *  this. */
  ctxSampleRate?: number;
}

interface ProfileEntry { id: string; name: string; centerFreq?: number; sampRate?: number }

/** Ham-band wavelength (m) → centre frequency (MHz). Used so profile names
 *  like "40m" or "80m" can match a target frequency. */
const HAM_BAND_MHZ: Record<number, number> = {
  160: 1.9, 80: 3.65, 60: 5.35, 40: 7.15, 30: 10.125, 20: 14.175,
  17: 18.118, 15: 21.225, 12: 24.94, 10: 28.85, 6: 50.15, 2: 144,
};

const MODE_MAP: Partial<Record<Mode, string>> = {
  lsb: 'lsb', lsn: 'lsb',
  usb: 'usb', usn: 'usb',
  am: 'am', amn: 'am', amw: 'am',
  cw: 'cw', cwn: 'cw',
  nbfm: 'nfm', nnfm: 'nfm',
  wfm:  'wfm',
  sam: 'am', sas: 'am', sal: 'am', sau: 'am',
};

const DEFAULT_TUNE: TuneParams = {
  mode: 'lsb',
  freqKHz: 7200,
  lowCutHz: -2700,
  highCutHz: -300,
};

export class OpenWebRxClient {
  private ws: WebSocket | null = null;
  private status: KiwiStatus = { connected: false };
  private tune: TuneParams = { ...DEFAULT_TUNE };

  /** Server-published config — needed to convert relative offsets and
   *  to decode binary frames correctly. */
  private centerFreq: number | null = null;
  private sampRate: number | null = null;
  private fftSize: number | null = null;
  private audioCompression: 'none' | 'adpcm' = 'none';
  private fftCompression: 'none' | 'adpcm' = 'none';

  private profiles: ProfileEntry[] = [];
  private selectedProfile: string | null = null;
  private dspStarted = false;
  /** Set when setTune() runs before the first config has arrived; flushed
   *  once we know centerFreq. */
  private pendingTune = false;

  private audioSeq = 0;
  private waterfallSeq = 0;
  // Audio uses the OWRX-port decoder (matches upstream reference exactly,
  // including SYNC scanner + syncCounter + per-frame `skip` continuity).
  private adpcm = new OwrxImaAdpcmCodec();
  // FFT uses the generic KiwiSDR-shape decoder — OpenWebRX resets ADPCM
  // state per FFT frame anyway, and the bytes there aren't audio.
  private fftAdpcm = new AdpcmDecoder();
  private seenTypes = new Set<string>();
  private binCounts: Record<string, number> = {};

  constructor(private opts: OpenWebRxClientOptions, private h: KiwiHandlers = {}) {}

  connect(): void {
    this.openWs();
  }

  disconnect(): void {
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.update({ connected: false });
  }

  setTune(p: Partial<TuneParams>): void {
    this.tune = { ...this.tune, ...p };
    this.pendingTune = true;
    // Maintain a view-centre that's independent of the tune frequency.
    // The cursor moves freely with the dial — when it walks off-screen
    // the shell renders an off-screen distance chip (matches KiwiSDR);
    // clicking the chip calls recenter() which re-anchors the view via
    // setZoom(). We deliberately do NOT auto-recenter here, even when
    // the dial walks well outside the visible window: that would yank
    // the waterfall out from under the user mid-tune.
    if (p.freqKHz != null) {
      if (this.viewCenterHz == null) {
        this.viewCenterHz = this.tune.freqKHz * 1000;
      }
      // If the dial walked outside the SDR's actual samp_rate window,
      // try a profile hop. Without this the slice silently clamps to the
      // coverage edge and the user hears nothing while seeing waterfall
      // labels that lie about the active range.
      if (this.shouldHopProfile()) {
        const hopped = this.hopToCoveringProfile();
        if (hopped) {
          // Next config will arrive with new center_freq; emitViewMeta
          // runs there. Skip the immediate emit + applyTune — applyTune
          // would compute an out-of-band offset against the about-to-be
          // -replaced centre.
          return;
        }
      }
      this.emitViewMeta();
    }
    this.applyTune();
  }
  setMode(mode: Mode): void { this.setTune({ mode }); }
  setFreqKHz(freqKHz: number): void { this.setTune({ freqKHz }); }
  setPassband(lowCutHz: number, highCutHz: number): void { this.setTune({ lowCutHz, highCutHz }); }
  /** Server-side zoom isn't part of the mainline OpenWebRX protocol — the
   *  server always sends `fft_size` bins covering the full `samp_rate`.
   *  We fake zoom client-side by slicing a window of bins around the
   *  tuned frequency inside handleFftFrame, and report the corresponding
   *  visible bandwidth to the shell so the cursor/labels stay in sync. */
  setZoom(zoom: number, centerKHz: number): void {
    this.zoomLevel = Math.max(0, Math.min(14, zoom | 0));
    this.viewCenterHz = centerKHz * 1000;
    this.emitViewMeta();
  }

  /** Push the current view-centre + visible-bandwidth so the shell can
   *  draw the cursor and translate clicks→frequency. Called whenever
   *  either changes (zoom, tune-outside-window, profile hop).
   *  The reported centre is clamped to the SDR's actual coverage so the
   *  frequency labels match the bins we're about to slice — without the
   *  clamp, dialing outside the SDR's samp_rate window would label a
   *  range the receiver isn't actually sampling. */
  private emitViewMeta(): void {
    if (this.sampRate == null || this.fftSize == null || this.viewCenterHz == null) return;
    const visibleBins = this.computeVisibleBins();
    const visibleHz = Math.round(this.sampRate * visibleBins / this.fftSize);
    let reportedCenter = this.viewCenterHz;
    if (this.centerFreq != null) {
      const halfCov  = this.sampRate / 2;
      const halfView = visibleHz / 2;
      const minView = this.centerFreq - halfCov + halfView;
      const maxView = this.centerFreq + halfCov - halfView;
      reportedCenter = Math.max(minView, Math.min(maxView, reportedCenter));
    }
    this.h.onMessage?.({
      bandwidth: String(visibleHz),
      owrx_view_center_khz: String(reportedCenter / 1000),
    });
  }

  private zoomLevel = 0;
  private viewCenterHz: number | null = null;

  /** Bins per emitted waterfall row at the current zoom. Halves per zoom
   *  step above 0, floored at 128 so the renderer always gets a usable
   *  array. At zoom 0 the full FFT is emitted. */
  private computeVisibleBins(): number {
    const full = this.fftSize ?? 16384;
    const want = full >> Math.max(0, this.zoomLevel);
    return Math.max(128, Math.min(full, want));
  }

  setSquelch(db: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Convert the Kiwi-style 0..N knob to dBFS — mainline OpenWebRX expects
    // an absolute squelch level. 0 disables; otherwise map roughly to
    // -150 + db so '50' lands near -100 dBFS.
    const level = db <= 0 ? -150 : -150 + db;
    this.sendJson({ type: 'dspcontrol', params: { squelch_level: level } });
  }

  /** OpenWebRX has no client-controllable AGC. We verified against both
   *  the jketterl mainline and the luarvique fork: their Demodulator.js
   *  only sends mod / low_cut / high_cut / offset_freq / squelch_level /
   *  secondary_mod / secondary_offset_freq. AGC is a server-side
   *  per-profile admin setting — the protocol does not expose it.
   *  These calls are kept as no-ops so the shell's AGC button (driven
   *  by the source-agnostic interface) doesn't crash; the shell shows
   *  a one-time banner explaining why the toggle is inert. */
  setAgc(_on: boolean, _manGain = 50): void { /* no-op — see comment */ }
  setAgcMode(_mode: 'fast' | 'med' | 'slow' | 'off', _manGain = 50): void { /* no-op */ }
  /** Compression is server-side config on OpenWebRX; ignored. */
  setAdpcm(_on: boolean): void { /* no-op */ }
  /** OpenWebRX noise blanker. Shell sends 0=off, 1=std, 2=auto, 3=Wild's.
   *  OWRX accepts `nb_enabled` (bool) + `nb_threshold` (int, dB) in
   *  dspcontrol — we map the shell's 4-step knob to a threshold ramp:
   *  off=disabled; std/auto/Wild's = 30/20/10 dB (stronger as the knob
   *  walks up, matching how the upstream WebUI's slider behaves). */
  setNoiseBlanker(algo: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (algo <= 0) {
      this.sendJson({ type: 'dspcontrol', params: { nb_enabled: false } });
    } else {
      const thr = algo === 1 ? 30 : algo === 2 ? 20 : 10;
      this.sendJson({
        type: 'dspcontrol',
        params: { nb_enabled: true, nb_threshold: thr },
      });
    }
  }
  /** OpenWebRX noise reduction. Verified against luarvique source
   *  (csdr/chain/clientaudio.py + owrx/dsp.py): the only NR knobs the
   *  server accepts are `nr_enabled` (bool) and `nr_threshold` (int).
   *  There is no algorithm enum on the wire — the `wdsp/lms/spec`
   *  labels surfaced by some UI forks just remap the same NoiseFilter
   *  at different thresholds. We do the same: shell modes 0..3 →
   *  disabled / mild / medium / aggressive. */
  setNoiseReduction(mode: number | boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const idx = typeof mode === 'boolean' ? (mode ? 1 : 0) : Math.max(0, Math.min(3, mode | 0));
    if (idx === 0) {
      this.sendJson({ type: 'dspcontrol', params: { nr_enabled: false } });
      return;
    }
    // Lower threshold = more aggressive (filter keeps less of the signal).
    const thr = [0, 30, 20, 10][idx];
    this.sendJson({
      type: 'dspcontrol',
      params: { nr_enabled: true, nr_threshold: thr },
    });
  }
  /** Waterfall pause/speed knobs — no client control on OpenWebRX; the
   *  server emits FFT frames at a fixed cadence per session. Kept as
   *  no-ops so the shell can call them without source-type branching. */
  wfPaused = false;
  wfSpeed = 2;
  setWfSpeed(_n: number): void { /* no-op */ }
  pauseWaterfall(): void { /* no-op */ }
  resumeWaterfall(): void { /* no-op */ }
  /** OpenWebRX doesn't expose a multi-user list to the WS protocol;
   *  per-receiver listener count arrives via `clients` JSON instead and
   *  is surfaced through onMessage. The callback is fired with an empty
   *  array so the shell's user panel just renders blank. */
  getUsers(cb: (users: never[]) => void): void { cb([]); }
  /** Compatibility field — mirrors KiwiClient's public flag. Always false
   *  for OpenWebRX since its ADPCM is server-decided and handled inside
   *  this client (the player only ever sees PCM frames). */
  adpcmRequested = false;

  /* ───────── internals ───────── */

  private openWs(): void {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.h.onMessage?.({ _debug: `opening OpenWebRX ${this.opts.url}` });

    ws.onopen = () => {
      // 1) Plain-text handshake.
      ws.send(`SERVER DE CLIENT client=${this.opts.ident ?? 'radiom'} type=receiver`);
      // 2) Request output rates that divide cleanly into the player's
      //    AudioContext sample rate (matches the native OpenWebRX
      //    client's `findRate` logic). Falls back to 12000 / 48000 when
      //    we don't know the context rate.
      const output_rate    = this.opts.audioOutRate
        ?? OpenWebRxClient.pickOutputRate(this.opts.ctxSampleRate,  8000, 12000)
        ?? 12000;
      const hd_output_rate = this.opts.hdAudioOutRate
        ?? OpenWebRxClient.pickOutputRate(this.opts.ctxSampleRate, 36000, 48000)
        ?? 48000;
      // Request UNCOMPRESSED audio (raw 16-bit LE PCM, ~2× the wire
      // bandwidth of ADPCM). ADPCM's 4-bit nibble + adaptive step
      // perceptibly squashes dynamics and dulls HF detail vs. the raw
      // PCM the OpenWebRX upstream web client gets when the server is
      // configured for `compression: none`. We follow the same
      // upstream `connectionproperties` key (`compression`) — the
      // server honours it if it supports raw, else falls back to
      // ADPCM and announces that via the `audio_compression` field of
      // the next config (which we already key off in handleText).
      this.sendJson({
        type: 'connectionproperties',
        params: { output_rate, hd_output_rate, compression: 'none' },
      });
      this.h.onMessage?.({ _debug: `owrx requested output_rate=${output_rate} hd=${hd_output_rate} compression=none ctxSR=${this.opts.ctxSampleRate ?? '?'}` });
      // Tell the player the input sample rate up-front so the resampler
      // doesn't briefly assume 12 kHz before the first config arrives.
      // Shell's kv handler picks up `audio_rate` and calls setInputRate.
      this.h.onMessage?.({ audio_rate: String(output_rate) });
      this.update({ connected: true });
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;   // guard against stale handlers post-reconnect
      if (typeof ev.data === 'string') {
        this.handleText(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        this.handleBinary(new Uint8Array(ev.data));
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.h.onError?.(new Error(`OpenWebRX socket error (url=${this.opts.url})`));
    };

    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.h.onError?.(new Error(`OpenWebRX closed code=${e.code} reason="${e.reason}" clean=${e.wasClean}`));
      this.ws = null;
      this.update({ connected: false });
      this.h.onClose?.();
    };
  }

  /** Pick a rate that's `Math.floor(ctxSampleRate / i)` and falls in
   *  [low, high]. Matches the native OpenWebRX `findRate`. Returns null
   *  if no integer divisor lands in range. */
  static pickOutputRate(ctxSR: number | undefined,
                        low: number, high: number): number | null {
    if (!ctxSR || ctxSR <= 0) return null;
    for (let i = 1; i < 64; i++) {
      const r = Math.floor(ctxSR / i);
      if (r < low) return null;
      if (r <= high) return r;
    }
    return null;
  }

  private handleText(text: string): void {
    if (text.startsWith('CLIENT DE SERVER')) {
      // Server handshake ack — extract version if present.
      const m = text.match(/version=(\S+)/);
      if (m) this.update({ version: m[1] });
      this.h.onMessage?.({ _debug: text });
      return;
    }
    let msg: { type?: string; value?: unknown; params?: unknown };
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object' || !msg.type) return;
    this.dispatchJson(msg);
  }

  private dispatchJson(msg: { type?: string; value?: unknown }): void {
    // Trace every JSON type we receive at least once per session so the
    // shell's log captures the protocol shape (no per-frame spam — we
    // dedupe on type).
    if (msg.type && !this.seenTypes.has(msg.type)) {
      this.seenTypes.add(msg.type);
      this.h.onMessage?.({ _debug: `owrx first-of-type ${msg.type} valueKeys=${msg.value && typeof msg.value === 'object' ? Object.keys(msg.value).slice(0, 12).join(',') : typeof msg.value}` });
    }
    switch (msg.type) {
      case 'config': {
        const v = msg.value as Record<string, unknown> | undefined;
        if (!v) { this.h.onMessage?.({ _debug: 'owrx config with empty value' }); return; }
        const prevCenter = this.centerFreq;
        if (typeof v.center_freq === 'number') this.centerFreq = v.center_freq;
        if (typeof v.samp_rate === 'number') this.sampRate = v.samp_rate;
        if (typeof v.fft_size === 'number') this.fftSize = v.fft_size;
        if (v.audio_compression === 'adpcm' || v.audio_compression === 'none')
          this.audioCompression = v.audio_compression;
        if (v.fft_compression === 'adpcm' || v.fft_compression === 'none')
          this.fftCompression = v.fft_compression;
        const patch: Partial<KiwiStatus> = {};
        if (this.centerFreq != null) patch.centerFreq = this.centerFreq;
        if (this.sampRate != null) {
          patch.sampleRate = this.sampRate;
          patch.bandwidth = this.sampRate;
        }
        if (Object.keys(patch).length) this.update(patch);
        // _debug must be emitted on its own — the shell's kv handler
        // short-circuits the whole message when it sees _debug, so mixing
        // data keys in would silently drop them.
        this.h.onMessage?.({
          _debug: `config center=${this.centerFreq} samp=${this.sampRate} fft=${this.fftSize} ac=${this.audioCompression} fc=${this.fftCompression}`,
        });
        if (this.centerFreq != null && this.sampRate != null) {
          const lo = this.centerFreq - this.sampRate / 2;
          const hi = this.centerFreq + this.sampRate / 2;
          // Kiwi-named keys for the existing shell handlers + an
          // OpenWebRX-prefixed pair the diag chip can show verbatim.
          this.h.onMessage?.({
            bandwidth: String(this.sampRate),
            center_freq: String(this.centerFreq),
            owrx_coverage_hz: `${Math.round(lo)}-${Math.round(hi)}`,
            owrx_coverage_label: `${fmtMHz(lo)}–${fmtMHz(hi)} (${fmtMHz(this.sampRate)} wide)`,
          });
        }
        // Reset codec state on every config (the server may have reset its
        // DSP chain too — predictor carrying across is what causes the
        // "audio gone scratchy after profile switch" symptom).
        this.adpcm.reset();
        this.fftAdpcm.reset();
        // (a) Apply the pending tune if this is the first config to give
        //     us a center_freq. (b) Re-apply on every center_freq change
        //     so a profile switch immediately retunes to the new offset.
        const centerChanged = this.centerFreq != null && this.centerFreq !== prevCenter;
        if (this.pendingTune || centerChanged) {
          // Mark pending so applyTune actually runs even if dspStarted is true.
          this.pendingTune = true;
          // 1. If the operator just picked a profile via the UI, honour
          //    it: snap the dial to the new band's centre BEFORE any hop
          //    heuristic gets a chance to override the choice.
          if (centerChanged && this.recenterDialOnNextConfig && this.centerFreq != null) {
            this.recenterDialOnNextConfig = false;
            const centreKHz = this.centerFreq / 1000;
            this.tune.freqKHz = centreKHz;
            this.viewCenterHz = this.centerFreq;
            this.h.onMessage?.({ owrx_dial_freq_khz: String(centreKHz) });
          } else {
            // 2. Otherwise, if the dial is outside the new coverage, try
            //    to hop to a band that contains it.
            if (this.shouldHopProfile()) {
              const hopped = this.hopToCoveringProfile();
              if (hopped) break;   // selectprofile sent — wait for next config
            }
            if (centerChanged) {
              // Normal profile drift (auto-hop / server-initiated). Just
              // re-anchor the view on the current dial freq.
              this.viewCenterHz = this.tune.freqKHz * 1000;
            }
          }
          this.applyTune();
          this.emitViewMeta();
        }
        break;
      }
      case 'profiles': {
        const arr = msg.value as Array<{ id: string; name: string }> | undefined;
        if (!Array.isArray(arr)) return;
        this.profiles = arr.map(p => ({ id: p.id, name: p.name }));
        this.h.onMessage?.({
          _debug: `profiles: ${this.profiles.map(p => p.id).join(',')}`,
        });
        // Surface the full list (and the currently selected one) so the
        // shell can offer an explicit picker — auto-selection by name is
        // a last resort; the operator should be able to choose.
        this.h.onMessage?.({
          owrx_profiles_json: JSON.stringify(this.profiles),
          owrx_selected_profile: this.selectedProfile ?? '',
        });
        // First connect: pick a profile covering the target freq. Don't
        // fall back to profiles[0] — that's often vlf/lf which can't
        // reach HF, and a wrong default would loop hop attempts.
        if (!this.selectedProfile && this.profiles.length) {
          if (!this.selectProfileForFreq(this.tune.freqKHz * 1000)) {
            // Try to find ANY HF profile by name; otherwise log and wait
            // for the user to pick something explicitly.
            this.h.onMessage?.({ _debug: 'owrx no profile matched target freq — server stays on default' });
          }
        }
        break;
      }
      case 'sdr_error':
      case 'demodulator_error':
        this.h.onError?.(new Error(`OpenWebRX ${msg.type}: ${String(msg.value)}`));
        break;
      case 'backoff':
        this.h.onMessage?.({ _debug: `backoff: ${JSON.stringify(msg.value)}` });
        break;
      case 'smeter': {
        // Push as a synthetic key-value so existing status panels can pick it up.
        const v = msg.value;
        if (typeof v === 'number') this.h.onMessage?.({ smeter: String(v) });
        break;
      }
      case 'clients':
        if (typeof msg.value === 'number') this.h.onMessage?.({ clients: String(msg.value) });
        break;
      case 'secondary_demod':
        // Server-side decoded digital text (FT8/POCSAG/etc.) — surface as a
        // diagnostic key for now; an eventual integration could short-circuit
        // matching client-side decoders.
        this.h.onMessage?.({ secondary_demod: JSON.stringify(msg.value) });
        break;
      case 'receiver_details':
      case 'features':
      case 'modes':
      case 'secondary_config':
      case 'metadata':
      case 'dial_frequencies':
      case 'bookmarks':
      case 'log_message':
        // Informational — passed through for any listener that wants it.
        this.h.onMessage?.({ [`owrx_${msg.type}`]: JSON.stringify(msg.value) });
        break;
      // luarvique "+" fork extras — fire every ~1 s. Acknowledged here so
      // the unhandled-type debug doesn't flood the log.
      case 'temperature':
      case 'cpuusage':
      case 'battery':
      case 'bands':
      case 'chat_message':
      case 'update':
        break;
      default:
        this.h.onMessage?.({ _debug: `unhandled owrx type=${msg.type}` });
    }
  }

  private handleBinary(buf: Uint8Array): void {
    if (buf.length < 1) return;
    const type = buf[0];
    const key = '0x' + type.toString(16).padStart(2, '0');
    const n = (this.binCounts[key] ?? 0) + 1;
    this.binCounts[key] = n;
    // Log the first few of each kind so we can confirm the wire format.
    if (n <= 3) {
      this.h.onMessage?.({ _debug: `owrx bin ${key} len=${buf.length} sample=${Array.from(buf.subarray(1, Math.min(buf.length, 9))).map(b => b.toString(16).padStart(2, '0')).join(' ')}` });
    }
    const body = buf.subarray(1);
    switch (type) {
      case 0x01: this.handleFftFrame(body); break;
      case 0x02: this.handleAudioFrame(body, false); break;
      case 0x03: /* secondary FFT — ignored for now */ break;
      case 0x04: this.handleAudioFrame(body, true); break;
    }
  }

  private handleAudioFrame(body: Uint8Array, _hd: boolean): void {
    let pcmBytesBE: Uint8Array;
    if (this.audioCompression === 'adpcm') {
      const samples = this.decodeAdpcmAudio(body);
      pcmBytesBE = int16ToBytesBE(samples);
    } else {
      // Wire format is int16 LE; flip to BE so player.decodePcmBe works.
      pcmBytesBE = swapEndian16(body);
    }
    const frame: AudioFrame = {
      seq: this.audioSeq++,
      smeter: 0,
      rssiDbm: -100,
      flags: 0,
      payload: pcmBytesBE,
      adpcm: false,
    };
    this.h.onAudio?.(frame);
  }

  private handleFftFrame(body: Uint8Array): void {
    if (this.fftSize == null) return;
    let dbm: Float32Array;
    if (this.fftCompression === 'adpcm') {
      // ADPCM-encoded FFT: decode to int16, drop first 10 sample (server pad),
      // divide by 100 to recover dBFS-ish floats.
      const i16 = new Int16Array(body.length * 2);
      this.fftAdpcm.reset();
      this.fftAdpcm.decodeInto(body, i16);
      const trimmed = i16.subarray(10);
      dbm = new Float32Array(this.fftSize);
      const n = Math.min(trimmed.length, this.fftSize);
      for (let i = 0; i < n; i++) dbm[i] = trimmed[i] / 100;
    } else {
      // Raw float32 LE, length = fft_size.
      const need = this.fftSize * 4;
      if (body.length < need) return;
      dbm = new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + need));
    }
    // Apply client-side zoom: slice a window of `visibleBins` centred on
    // the tuned frequency (or the explicit view-centre if set via setZoom).
    const visibleBins = this.computeVisibleBins();
    let startBin = 0;
    if (visibleBins < dbm.length && this.centerFreq != null && this.sampRate != null) {
      const focusHz = this.viewCenterHz ?? this.tune.freqKHz * 1000;
      const offsetHz = focusHz - this.centerFreq;
      const offsetBins = Math.round(offsetHz * dbm.length / this.sampRate);
      const centreBin = Math.round(dbm.length / 2 + offsetBins);
      startBin = Math.max(0, Math.min(dbm.length - visibleBins, centreBin - (visibleBins >> 1)));
    }
    const dbmView = visibleBins < dbm.length ? dbm.subarray(startBin, startBin + visibleBins) : dbm;
    // Map to bytes the same way KiwiSDR does: 0..255 over -110..-10 dBm.
    const MIN_DB = -110, MAX_DB = -10, SPAN = MAX_DB - MIN_DB;
    const bins = new Uint8Array(dbmView.length);
    for (let i = 0; i < dbmView.length; i++) {
      let b = Math.round((dbmView[i] - MIN_DB) / SPAN * 255);
      if (b < 0) b = 0; else if (b > 255) b = 255;
      bins[i] = b;
    }
    const wf: WaterfallFrame = {
      xBinServer: 0,
      flags: 0,
      seq: this.waterfallSeq++,
      bins,
    };
    this.h.onWaterfall?.(wf);
  }

  private decodeAdpcmAudio(body: Uint8Array): Int16Array {
    // OwrxImaAdpcmCodec handles SYNC markers, per-byte `syncCounter`,
    // and frame-boundary continuity via its internal `skip` field, so
    // we hand the raw payload straight in.
    return this.adpcm.decodeWithSync(body);
  }

  private selectProfileForFreq(hz: number): ProfileEntry | null {
    // Two heuristics, tried in order:
    //   1) Profile-name pattern match — most reliable when admins name
    //      profiles after band labels (e.g. "40m", "7.0 MHz", "ham_06").
    //   2) Generic HF hints (kw/shortwave/hf/kurzwelle) — covers all of
    //      HF, good fallback for SW tuning when no per-band profile matches.
    const target = hz / 1e6;
    for (const p of this.profiles) {
      const tail = p.id.split('|').pop()?.toLowerCase() ?? '';
      // Require an explicit unit (MHz/kHz/m) so generic sequence numbers
      // like "ham_07" or "bc_13" don't get misread as 7 MHz / 13 MHz.
      const m = (p.name + ' ' + tail).match(/(\d+(?:\.\d+)?)\s*(MHz|kHz|m\b)/i);
      if (!m) continue;
      const raw = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      let mhz = raw;
      if (unit === 'khz') mhz = raw / 1000;
      else if (unit === 'm') mhz = HAM_BAND_MHZ[raw] ?? raw;
      if (Math.abs(mhz - target) < 0.5) {
        // Only count this as a hop if we actually changed profiles —
        // otherwise the caller's loop-prevention logic thinks it made
        // progress and skips its fallback path.
        return this.tryHopProfile(p);
      }
    }
    const HF_HINTS = ['kw', 'shortwave', 'hf', 'kurzwelle', 'sw'];
    if (target >= 1.5 && target <= 30) {
      for (const p of this.profiles) {
        const tail = p.id.split('|').pop()?.toLowerCase() ?? '';
        if (HF_HINTS.includes(tail)) {
          return this.tryHopProfile(p);
        }
      }
    }
    return null;
  }

  /** Send selectprofile only if id differs from the current selection
   *  and return the profile (or null when it would have been a no-op). */
  private tryHopProfile(p: ProfileEntry): ProfileEntry | null {
    if (this.selectedProfile === p.id) return null;
    this.selectProfile(p.id);
    return p;
  }


  /** Should we hop profiles? Yes when the requested freq lies outside the
   *  current samp_rate window centred on center_freq. */
  private shouldHopProfile(): boolean {
    if (this.centerFreq == null || this.sampRate == null) return false;
    const target = this.tune.freqKHz * 1000;
    const half = this.sampRate / 2;
    return Math.abs(target - this.centerFreq) > half * 0.95;
  }

  private hopToCoveringProfile(): ProfileEntry | null {
    return this.selectProfileForFreq(this.tune.freqKHz * 1000);
  }

  private selectProfile(id: string): void {
    this.selectedProfile = id;
    this.dspStarted = false;
    this.sendJson({ type: 'selectprofile', params: { profile: id } });
    this.h.onMessage?.({ owrx_selected_profile: id });
  }

  /** Public entry point for the UI: choose a specific (SDR, profile)
   *  pair by its server-side id (e.g. "rtl_usb_110|kw"). Bypasses the
   *  auto-pick heuristic; subsequent config arrivals respect this until
   *  the dial walks outside coverage. The dial is snapped to the new
   *  profile's centre on the next config so the operator lands in the
   *  middle of the band rather than potentially outside coverage. */
  selectProfileById(id: string): void {
    this.recenterDialOnNextConfig = true;
    this.selectProfile(id);
  }

  private recenterDialOnNextConfig = false;

  /** Snapshot of the currently advertised profile list. */
  getProfiles(): ReadonlyArray<{ id: string; name: string }> { return this.profiles; }
  getSelectedProfile(): string | null { return this.selectedProfile; }

  private applyTune(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.centerFreq == null) return;     // wait for first config
    const offset = Math.round(this.tune.freqKHz * 1000 - this.centerFreq);
    const owrxMod = MODE_MAP[this.tune.mode];
    if (!owrxMod) {
      this.h.onError?.(new Error(`OpenWebRX has no mapping for mode "${this.tune.mode}"`));
      return;
    }
    // Only the params upstream's own JS client actually sends — we
    // confirmed the server silently ignores anything else (and AGC in
    // particular is server-side admin config, not client-controllable).
    const params: Record<string, unknown> = {
      mod: owrxMod,
      offset_freq: offset,
      low_cut: this.tune.lowCutHz,
      high_cut: this.tune.highCutHz,
    };
    const body: Record<string, unknown> = { type: 'dspcontrol', params };
    if (!this.dspStarted) {
      body.action = 'start';
      this.dspStarted = true;
    }
    this.sendJson(body);
    this.pendingTune = false;
  }

  private sendJson(obj: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  private update(patch: Partial<KiwiStatus>): void {
    this.status = { ...this.status, ...patch };
    this.h.onStatus?.(this.status);
  }
}

function swapEndian16(le: Uint8Array): Uint8Array {
  const n = le.length & ~1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 2) { out[i] = le[i + 1]; out[i + 1] = le[i]; }
  return out;
}

function fmtMHz(hz: number): string {
  const mhz = hz / 1e6;
  return mhz >= 10 ? `${mhz.toFixed(2)} MHz` : `${mhz.toFixed(3)} MHz`;
}

function int16ToBytesBE(s: Int16Array): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    out[i * 2]     = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}
