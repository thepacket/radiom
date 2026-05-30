// Copyright (c) Andre Paquette
//
// SpyServer bridge — Node TCP↔WebSocket proxy for Airspy's
// "spyserver" daemon (Airspy HF+, Airspy R2/Mini, sometimes RTL-SDR
// wrapped in spyserver). Browser opens a WebSocket to
// /ws/spyserver/<host>:<port>; the bridge maintains a TCP connection
// to the spyserver and forwards int16 IQ samples down the WS plus a
// JSON control plane in both directions.
//
// Protocol reference: cross-checked against the SDR++ source
// (modules/source/spyserver_source) and the Airspy SPY Server
// protocol documentation that ships with spyserver_protocol.h.
//
// Wire format — ASYMMETRIC headers. The client→server header is just
// 8 bytes; the server→client header is 20 bytes. Both LE.
//
//   client → server (SpyServerCommandHeader, 8 bytes):
//     uint32 commandType
//     uint32 bodySize
//
//   server → client (SpyServerMessageHeader, 20 bytes):
//     uint32 protocolID         SPYSERVER_PROTOCOL_VERSION
//     uint32 messageType
//     uint32 streamType         which of IQ / AUDIO / FFT this frame is
//     uint32 sequenceNumber
//     uint32 bodySize           bytes in body that follow
//
// HELLO body (client → server): JUST a uint32 protocolVersion. No
// client name despite what some online references claim.
//
// Setting writes (SET_SETTING command body):
//   uint32 settingType
//   uint32 settingValue
//
// For radiom's IQ-only first-cut path:
//   1. Send HELLO with protocolID + clientName.
//   2. Wait for DEVICE_INFO.
//   3. Pick a decimation stage that yields ~200–500 kS/s output rate.
//   4. SET_SETTING IQ_FORMAT = INT16
//      SET_SETTING IQ_FREQUENCY = current dial
//      SET_SETTING IQ_DECIMATION = chosen stage
//      SET_SETTING STREAMING_MODE = IQ
//      SET_SETTING STREAMING_ENABLED = 1
//   5. Forward every INT16_IQ stream-type message body verbatim to
//      the browser as a binary WS frame. The body is already
//      interleaved int16 LE I/Q — exactly what the rtl_tcp path
//      produces, which is the existing IQ pipeline's wire format.
//
// JSON control plane (client → bridge):
//   { t: 'freq',  hz }    — retune
//   { t: 'gain',  idx }   — set gain index (device-dependent)
//
// JSON control plane (bridge → client):
//   { t: 'hello',  device, srOut, minHz, maxHz, maxGain, …  }
//   { t: 'status', msg }
//
// Binary frames (bridge → client) are always int16 LE IQ pairs at
// `srOut` Hz.

import net from 'node:net';
import { CsdrPipeline } from './csdr-pipeline.mjs';

// ── Protocol constants ─────────────────────────────────────────────

const CMD_HEADER_LEN = 8;     // client → server
const MSG_HEADER_LEN = 20;    // server → client

// SpyServer protocol version packed as (MAJOR << 24) | (MINOR << 16) |
// REVISION. SDR++ defines this as SPYSERVER_PROTOCOL_VERSION =
// (2<<24) | (0<<16) | 1700 — same value we use here.
const PROTOCOL_VERSION = (2 << 24) | (0 << 16) | 1700;     // 0x020006A4

// Client → Server message types
const MSG_HELLO       = 0;
const MSG_GET_SETTING = 1;
const MSG_SET_SETTING = 2;
const MSG_PING        = 3;

// Server → Client message types
const SRV_MSG_DEVICE_INFO  = 0;
const SRV_MSG_CLIENT_SYNC  = 1;
const SRV_MSG_PONG         = 2;
const SRV_MSG_READ_SETTING = 3;
const SRV_MSG_UINT8_IQ     = 100;
const SRV_MSG_INT16_IQ     = 101;
const SRV_MSG_INT24_IQ     = 102;
const SRV_MSG_FLOAT_IQ     = 103;
const SRV_MSG_UINT8_FFT    = 200;
const SRV_MSG_INT16_FFT    = 201;
const SRV_MSG_UINT8_AUDIO  = 300;
const SRV_MSG_INT16_AUDIO  = 301;

// Setting IDs
const SETTING_STREAMING_MODE     = 0;
const SETTING_STREAMING_ENABLED  = 1;
const SETTING_GAIN               = 2;
const SETTING_IQ_FORMAT          = 100;
const SETTING_IQ_FREQUENCY       = 101;
const SETTING_IQ_DECIMATION      = 102;
const SETTING_IQ_DIGITAL_GAIN    = 103;
const SETTING_FFT_FORMAT         = 200;
const SETTING_FFT_FREQUENCY      = 201;
const SETTING_FFT_DECIMATION     = 202;
const SETTING_FFT_DB_OFFSET      = 203;
const SETTING_FFT_DB_RANGE       = 204;
const SETTING_FFT_DISPLAY_PIXELS = 205;
const SETTING_AUDIO_FORMAT       = 300;
const SETTING_AUDIO_FREQUENCY    = 301;
const SETTING_AUDIO_DECIMATION   = 302;
const SETTING_AUDIO_DIGITAL_GAIN = 303;
const SETTING_AUDIO_DEMOD_MODE   = 304;
const SETTING_AUDIO_BANDWIDTH    = 305;
const SETTING_AUDIO_OUTPUT_RATE  = 306;

// Streaming modes (bitfield combinable)
const STREAM_MODE_IQ             = 0x01;
const STREAM_MODE_AUDIO          = 0x02;
const STREAM_MODE_FFT            = 0x04;

// Format IDs
const FORMAT_UINT8 = 1;
const FORMAT_INT16 = 2;

// Demodulator modes — SpyServer's enum
const DEMOD_AM    = 1;
const DEMOD_NBFM  = 2;
const DEMOD_WBFM  = 3;
const DEMOD_USB   = 4;
const DEMOD_LSB   = 5;
const DEMOD_CW    = 6;
const DEMOD_RAW   = 7;

// Map radiom mode strings → SpyServer demod constants.
const MODE_TO_DEMOD = {
  am: DEMOD_AM, sam: DEMOD_AM, sal: DEMOD_AM, sau: DEMOD_AM,
  nbfm: DEMOD_NBFM, nfm: DEMOD_NBFM,
  wfm: DEMOD_WBFM,
  usb: DEMOD_USB,
  lsb: DEMOD_LSB,
  cw:  DEMOD_CW,
  iq:  DEMOD_RAW,
};

// Binary WS frame tag bytes — each binary frame the bridge forwards to
// the browser is prefixed with one of these so the client can demux.
const TAG_IQ    = 0x00;
const TAG_AUDIO = 0x01;
const TAG_FFT   = 0x02;

// Device-type IDs (mapped to a human label only; correctness optional)
const DEVICE_LABELS = {
  0: 'invalid',
  1: 'Airspy One (R2/Mini)',
  2: 'Airspy HF+',
  3: 'RTL-SDR',
  4: 'BladeRF',
  5: 'HackRF',
  6: 'LimeSDR',
  7: 'SDRplay',
};

const CLIENT_NAME = 'radiom 0.4';

// Pick a decimation stage that yields output rate roughly in
// `[target/2, target*2]` and prefer the closest. SpyServer divides
// the raw device rate by 2^stage.
function pickDecimationStage(maxSr, target = 250_000, maxStage = 8) {
  let best = 0;
  let bestDelta = Math.abs(maxSr - target);
  for (let s = 0; s <= maxStage; s++) {
    const r = maxSr / (1 << s);
    if (r < 1000) break;
    const d = Math.abs(r - target);
    if (d < bestDelta) { best = s; bestDelta = d; }
  }
  return best;
}

export class SpyServerBridge {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {(buf: Buffer) => void}  opts.onIq      — int16 BE IQ
   * @param {(buf: Buffer) => void}  [opts.onAudio] — int16 BE audio PCM
   * @param {(buf: Buffer) => void}  [opts.onFft]   — uint8 FFT bins
   * @param {(info: object) => void} [opts.onHello]
   * @param {(msg: string) => void}  [opts.onStatus]
   * @param {number}                 [opts.demodMode]   — SpyServer demod ID
   * @param {number}                 [opts.audioBwHz]   — audio passband width Hz
   * @param {number}                 [opts.streamMode]  — bitfield of STREAM_MODE_*
   */
  constructor(opts) {
    this.opts = opts;
    this.sock = null;
    this.closed = false;
    this.recvBuf = Buffer.alloc(0);
    this.gotDeviceInfo = false;
    this.gotSync = false;
    this.seq = 0;
    this.maxSr = 0;
    this.minHz = 0;
    this.maxHz = 0;
    this.maxGain = 0;
    this.deviceType = 0;
    this.decimStage = 0;
    this.srOut = 0;
    this.pendingFreqHz = null;
    this.pendingGain = null;
    this.pingTimer = null;
    // Current demod settings — populated by setMode / setPassband
    // from the browser and re-applied to the server on reconnect.
    this.demodMode  = opts.demodMode  ?? DEMOD_USB;     // 4 (USB) — safe default
    this.audioBwHz  = opts.audioBwHz  ?? 3000;          // 3 kHz default
    // Default to AUDIO_ONLY. Combined AUDIO|FFT (0x06) is the natural
    // wish but many SpyServer implementations either ignore one of the
    // two modes or refuse to stream at all when given a multi-bit value
    // (observed: R2 + RTL servers send DEVICE_INFO and CLIENT_SYNC
    // then sit silent with mode=0x6, watchdog tears down). Single-mode
    // requests are what SDR++ / SDR# use in the wild.
    this.streamMode = opts.streamMode ?? STREAM_MODE_AUDIO;
    // Server-side DSP pipeline (csdr). Lazily constructed in
    // feedCsdr once we know srOut + a demod mode.
    this.csdr = null;
    // Phase accumulator for the JS-side IQ frequency shift. Persists
    // across feedCsdr calls and across shiftHz changes so transitions
    // are clickless (no phase reset at the boundary).
    this.shiftPhase = 0;
    this.connect();
  }

  /** Bridge between SpyServer IQ and the csdr demod/FFT chains. */
  feedCsdr(le16IqBuf) {
    if (!this.srOut || !le16IqBuf || !le16IqBuf.length) return;
    if (!this.csdr) {
      const modeStr = Object.keys(MODE_TO_DEMOD).find(
        (k) => MODE_TO_DEMOD[k] === this.demodMode,
      ) || 'usb';
      this.csdr = new CsdrPipeline({
        inputRate: this.srOut,
        mode: modeStr,
        passLoHz: this.passLoHz ?? null,
        passHiHz: this.passHiHz ?? null,
        bandpassTaps: this.bandpassTaps ?? null,
        agcProfile: this.agcProfile ?? 'off',
        fixedGain:  this.fixedGain  ?? 8,
        onAudio: (buf) => this.opts.onAudio?.(buf),
        onFft:   (buf) => this.opts.onFft?.(buf),
        onStatus: (m) => this.opts.onStatus?.(m),
      });
      this.announceCsdrRate();
      // Apply any pending shift that arrived before the pipeline was
      // up (e.g. the user dialed during connect setup).
      if (this.shiftHz) this.csdr.setShift(-this.shiftHz / this.srOut);
    } else if (this.csdr.inputRate !== this.srOut) {
      this.csdr.setInputRate(this.srOut);
      // Re-apply shift with the new normalisation since rate changed.
      if (this.shiftHz) this.csdr.setShift(-this.shiftHz / this.srOut);
      this.announceCsdrRate();
    }
    this.csdr.feedIq(le16IqBuf);
  }

  /** Notify the WS client of the current csdr audio output rate so the
   *  browser player can sync its input rate. Fires every time the
   *  pipeline (re)builds — initial spawn, mode change, BW change. */
  announceCsdrRate() {
    const rate = this.csdr?.getAudioRate();
    if (!rate) return;
    if (rate === this._lastAnnouncedAudioRate) return;
    this._lastAnnouncedAudioRate = rate;
    this.opts.onHello?.({
      device: DEVICE_LABELS[this.deviceType] || `unknown(${this.deviceType})`,
      deviceType: this.deviceType,
      srOut: this.srOut,
      maxSr: this.maxSr,
      minHz: this.minHz,
      maxHz: this.maxHz,
      maxGain: this.maxGain,
      decimStage: this.decimStage,
      tunedHz: this.pendingFreqHz ?? 0,
      streamMode: this.streamMode,
      demodMode: this.demodMode,
      audioBwHz: this.audioBwHz,
      audioRate: rate,
    });
  }

  connect() {
    this.sock = net.createConnection({ host: this.opts.host, port: this.opts.port }, () => {
      this.opts.onStatus?.(`connected to spyserver ${this.opts.host}:${this.opts.port}`);
      this.sendHello();
      // Heartbeat — SpyServer typically closes idle TCP sessions after
      // ~30 seconds. SDR++ sends a CMD_PING every 5 seconds; we do the
      // same. Server replies with MSG_PONG; we don't care about the
      // reply other than to know the socket is still alive.
      this.pingTimer = setInterval(() => {
        if (this.sock && !this.sock.destroyed) {
          this.sendCommand(MSG_PING);
        }
      }, 5000);
    });
    this.sock.setNoDelay(true);
    this.sock.on('data', (chunk) => this.consume(chunk));
    this.sock.on('error', (err) => this.opts.onStatus?.(`spyserver error: ${err.message}`));
    this.sock.on('close', () => {
      if (this.pingTimer != null) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (!this.closed) this.opts.onStatus?.('spyserver closed');
      this.sock = null;
    });
  }

  // ── Outbound framing ──────────────────────────────────────────────

  sendCommand(cmdType, body = Buffer.alloc(0)) {
    if (!this.sock || this.sock.destroyed) return;
    const header = Buffer.alloc(CMD_HEADER_LEN);
    header.writeUInt32LE(cmdType, 0);
    header.writeUInt32LE(body.length, 4);
    try {
      this.sock.write(header);
      if (body.length) this.sock.write(body);
    } catch (e) {
      this.opts.onStatus?.(`spyserver write failed: ${e.message}`);
    }
  }

  sendHello() {
    // Body: JUST a uint32 protocolVersion. SDR++'s SpyServerClient-
    // Handshake struct has only that one field. Earlier we appended a
    // UTF-8 client name; that's not in the SDR++ format and caused
    // every public server to reject the connection.
    const body = Buffer.alloc(4);
    body.writeUInt32LE(PROTOCOL_VERSION, 0);
    this.sendCommand(MSG_HELLO, body);
  }

  setSettingU32(settingId, value) {
    const body = Buffer.alloc(8);
    body.writeUInt32LE(settingId, 0);
    body.writeUInt32LE(value >>> 0, 4);
    this.sendCommand(MSG_SET_SETTING, body);
  }

  /** Apply the standard IQ streaming setup once we know the device. */
  /** Send the full stack of stream settings (format, decim, freq,
   *  gain, mode, then ENABLED). Called once we have DEVICE_INFO +
   *  CLIENT_SYNC and again on every external setMode / setStreamMode
   *  / setPassband. The order matches SDR++. */
  configureStream(freqHz, gainIdx) {
    if (!this.gotDeviceInfo) return;
    const wantIq    = !!(this.streamMode & STREAM_MODE_IQ);
    const wantAudio = !!(this.streamMode & STREAM_MODE_AUDIO);
    const wantFft   = !!(this.streamMode & STREAM_MODE_FFT);
    const clampedHz = Math.max(this.minHz || 0, Math.min(this.maxHz || 0xffffffff, freqHz | 0));
    // Pick decim stage based on what we're actually streaming. For IQ
    // we target ~250 kS/s; for audio-only/FFT-only the server handles
    // its own internal decim chain so we just need any sane stage.
    if (wantIq) {
      this.decimStage = pickDecimationStage(this.maxSr, 250_000);
    } else {
      // Audio-mode: prefer a higher stage to keep server-side CPU low.
      this.decimStage = pickDecimationStage(this.maxSr, 48_000);
    }
    this.srOut = Math.max(1, Math.round(this.maxSr / (1 << this.decimStage)));

    // Back to IQ-only — server-side audio mode wasn't working on any
    // tested server (R2, RTL-SDR, HF+). All accepted settings, replied
    // to PINGs, but never sent audio. Going back to the v0.4.44 IQ
    // path that DID work, just at much lower rate.
    //
    // Bandwidth-driven decimation: target IQ rate = audioBwHz × 3.
    // The × 3 gives margin for SSB asymmetric demod (lowCut..highCut
    // is not symmetric around DC) and a touch of anti-alias slack.
    // Clamped to 6-48 kHz: tighter than 6 kHz would clip even narrow
    // SSB; wider than 48 kHz is pointless for any voice mode and just
    // burns fly bandwidth. Narrower BW → narrower IQ → less integrated
    // noise → better SNR for that mode, and proportionally less data
    // through the proxy (a 2.7 kHz SSB session runs at ~8 kS/s IQ ≈
    // 32 KB/s; a 12 kHz NBFM session at ~36 kS/s IQ ≈ 144 KB/s).
    this.streamMode = STREAM_MODE_IQ;
    // Floor the IQ rate at 12 kHz. The downstream csdr pipeline
    // guarantees a fixed 12 kHz audio output via fractional_decimator_ff
    // — but that can only DECIMATE, not interpolate, so we need IQ
    // rate >= 12 kHz at all times. 12 kHz IQ × 4 bytes/sample = 48 KB/s
    // which is fine for fly.io egress.
    const target = Math.max(12_000, Math.min(48_000, (this.audioBwHz | 0) * 3));
    this.decimStage = pickDecimationStage(this.maxSr, target);
    this.srOut = Math.max(1, Math.round(this.maxSr / (1 << this.decimStage)));
    this.setSettingU32(SETTING_IQ_FORMAT,       FORMAT_INT16);
    this.setSettingU32(SETTING_IQ_FREQUENCY,    clampedHz);
    this.setSettingU32(SETTING_IQ_DECIMATION,   this.decimStage);
    if (gainIdx != null) this.setSettingU32(SETTING_GAIN, Math.max(0, gainIdx | 0));
    this.setSettingU32(SETTING_STREAMING_MODE,    STREAM_MODE_IQ);
    this.setSettingU32(SETTING_STREAMING_ENABLED, 1);
    void wantIq; void wantAudio; void wantFft;
    this.opts.onHello?.({
      device: DEVICE_LABELS[this.deviceType] || `unknown(${this.deviceType})`,
      deviceType: this.deviceType,
      srOut: this.srOut,
      maxSr: this.maxSr,
      minHz: this.minHz,
      maxHz: this.maxHz,
      maxGain: this.maxGain,
      decimStage: this.decimStage,
      tunedHz: clampedHz,
      streamMode: this.streamMode,
      demodMode: this.demodMode,
      audioBwHz: this.audioBwHz,
      // Pull the audio rate from the live csdr pipeline if it exists.
      // Otherwise leave null — the bridge will emit a follow-up hello
      // via announceCsdrRate() once the first IQ frame at the new rate
      // arrives and the pipeline (re)builds. Emitting a guess here
      // (e.g. 12000) and having the client fall back to srOut for a
      // missing value caused the pitch-shift + on/off audio behaviour
      // on every BW change.
      audioRate: this.csdr?.getAudioRate() ?? null,
    });
  }

  // ── Inbound parsing ───────────────────────────────────────────────

  consume(chunk) {
    // Diagnostic: log the first byte chunk we see from the server in
    // hex form. If the server hangs up without ever sending a byte,
    // this log line never appears and we know it's a HELLO-reject.
    if (!this.firstRxLogged) {
      const hex = chunk.subarray(0, Math.min(48, chunk.length)).toString('hex');
      this.opts.onStatus?.(`first rx (${chunk.length} bytes): ${hex}`);
      this.firstRxLogged = true;
    }
    this.recvBuf = this.recvBuf.length ? Buffer.concat([this.recvBuf, chunk]) : chunk;
    while (this.recvBuf.length >= MSG_HEADER_LEN) {
      const bodySize = this.recvBuf.readUInt32LE(16);
      if (this.recvBuf.length < MSG_HEADER_LEN + bodySize) return;
      const messageType = this.recvBuf.readUInt32LE(4);
      const streamType  = this.recvBuf.readUInt32LE(8);
      const body = this.recvBuf.subarray(MSG_HEADER_LEN, MSG_HEADER_LEN + bodySize);
      // Log control messages but suppress per-frame IQ chatter (would
      // otherwise produce hundreds of lines per second).
      if (messageType < 100) {
        this.opts.onStatus?.(`rx msg type=${messageType} stream=${streamType} body=${body.length}`);
      }
      this.dispatch(messageType, streamType, body);
      this.recvBuf = this.recvBuf.subarray(MSG_HEADER_LEN + bodySize);
    }
  }

  dispatch(messageType, streamType, body) {
    void streamType;
    switch (messageType) {
      case SRV_MSG_DEVICE_INFO:  return this.onDeviceInfo(body);
      case SRV_MSG_CLIENT_SYNC:  return this.onClientSync(body);
      case SRV_MSG_PONG:         return;
      // Both IQ formats are accepted. Airspy R2 servers default to
      // UINT8 even when we request INT16; HF+ servers honour INT16.
      // Both paths emit int16 BE (Kiwi convention) to the WS.
      case SRV_MSG_UINT8_IQ:     return this.onUint8Iq(body);
      case SRV_MSG_INT16_IQ:     return this.onInt16Iq(body);
      case SRV_MSG_INT16_AUDIO:  return this.onInt16Audio(body);
      case SRV_MSG_UINT8_FFT:    return this.onUint8Fft(body);
      // Higher-bit / unused formats — log if seen.
      case SRV_MSG_INT24_IQ:
      case SRV_MSG_FLOAT_IQ:
      case SRV_MSG_INT16_FFT:
      case SRV_MSG_UINT8_AUDIO:
        this.opts.onStatus?.(`unexpected stream type ${messageType} body=${body.length}`);
        return;
      default:
        this.opts.onStatus?.(`unknown msgType ${messageType}`);
        return;
    }
  }

  /** UINT8 IQ — each sample is a byte 0..255. Lift to int16 centred
   *  on 128 (so b=128 → 0) and scale ×256 to fill the 16-bit range.
   *  Output is int16 BE — same shape as the Kiwi IQ wire format every
   *  IQ-side viewer expects. */
  onUint8Iq(body) {
    if (body.length < 2) return;
    // Build LE int16 first (for csdr) and BE int16 (for the IQ viewers).
    const leOut = Buffer.allocUnsafe(body.length * 2);
    const beOut = Buffer.allocUnsafe(body.length * 2);
    for (let i = 0; i < body.length; i++) {
      const v = (body[i] - 128) * 256;
      // LE
      leOut[i * 2]     = v        & 0xff;
      leOut[i * 2 + 1] = (v >> 8) & 0xff;
      // BE
      beOut[i * 2]     = (v >> 8) & 0xff;
      beOut[i * 2 + 1] = v        & 0xff;
    }
    this.feedCsdr(leOut);
    this.opts.onIq?.(beOut);
  }

  onDeviceInfo(body) {
    // device_info layout (SDR++ / spyserver_protocol.h):
    //   uint32 device_type
    //   uint32 device_serial
    //   uint32 max_sample_rate
    //   uint32 max_bandwidth
    //   uint32 decimation_stage_count
    //   uint32 gain_stage_count
    //   uint32 maximum_gain_index
    //   uint32 minimum_frequency
    //   uint32 maximum_frequency
    //   uint32 resolution
    //   uint32 min_iq_decimation
    //   uint32 forced_iq_format
    if (body.length < 48) {
      this.opts.onStatus?.(`device_info too short (${body.length} bytes)`);
      return;
    }
    this.deviceType = body.readUInt32LE(0);
    this.maxSr      = body.readUInt32LE(8);
    this.maxGain    = body.readUInt32LE(24);
    this.minHz      = body.readUInt32LE(28);
    this.maxHz      = body.readUInt32LE(32);
    this.gotDeviceInfo = true;
    // Don't kick off the stream until we also see CLIENT_SYNC — some
    // servers (Airspy HF+ in particular) report device_info first but
    // need the client to wait for sync before they accept settings.
  }

  onClientSync(body) {
    void body;
    this.gotSync = true;
    if (this.gotDeviceInfo) {
      this.configureStream(
        this.pendingFreqHz ?? Math.max(0, Math.min(this.maxHz, this.minHz + 1_000_000)),
        this.pendingGain ?? Math.floor(this.maxGain * 0.6),
      );
    }
  }

  onInt16Iq(body) {
    if (body.length < 4) return;
    // Feed csdr (LE in / LE out) BEFORE the byte-swap that the IQ
    // viewers downstream expect. csdr reads native-endian int16 floats
    // and the spyserver wire format is already LE, so this is a direct
    // pass-through into the demod + FFT pipelines.
    this.feedCsdr(body);
    // The body is already int16 LE I/Q interleaved at `srOut`. Browser
    // pipeline expects BIG-endian int16 (Kiwi convention reused by rtl_tcp
    // bridge — see Kiwi IQ-mode), so byte-swap each sample pair.
    const out = Buffer.allocUnsafe(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      out[i]     = body[i + 1];
      out[i + 1] = body[i];
    }
    this.opts.onIq?.(out);
  }

  /** Server-side-demodulated PCM audio. Bytes are int16 LE; the Kiwi
   *  audio path wants int16 BE, so byte-swap each pair the same way
   *  we do for IQ. Output is mono PCM at 12 kHz (we requested
   *  AUDIO_OUTPUT_RATE = 12000). */
  onInt16Audio(body) {
    if (body.length < 2) return;
    const out = Buffer.allocUnsafe(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      out[i]     = body[i + 1];
      out[i + 1] = body[i];
    }
    this.opts.onAudio?.(out);
  }

  /** Server-side FFT — uint8 dB-scaled bin values. We requested
   *  1024 bins (SETTING_FFT_DISPLAY_PIXELS) and UINT8 format. Forward
   *  verbatim; client wraps as a WaterfallFrame and pushes to the
   *  spectrum view. */
  onUint8Fft(body) {
    if (body.length < 1) return;
    this.opts.onFft?.(body);
  }

  // ── External control ──────────────────────────────────────────────

  setFreq(hz) {
    this.pendingFreqHz = hz | 0;
    if (this.gotSync) this.setSettingU32(SETTING_IQ_FREQUENCY, this.pendingFreqHz);
  }
  setGainIndex(idx) {
    this.pendingGain = Math.max(0, idx | 0);
    this.opts.onStatus?.(`setGainIndex idx=${this.pendingGain} sync=${this.gotSync}`);
    if (this.gotSync) this.setSettingU32(SETTING_GAIN, this.pendingGain);
  }

  /** Set audio passband cutoffs in Hz (signed, relative to dial).
   *  For LSB: lo=-2700, hi=-300. For USB: lo=300, hi=2700. For AM:
   *  lo=-bw/2, hi=+bw/2. The csdr pipeline uses these to drive its
   *  bandpass filter (and the SSB shift). Without this the audio
   *  filter would stay locked at the hardcoded mode default and the
   *  BW knob would be silent. */
  setPassband(loHz, hiHz) {
    this.passLoHz = Math.round(loHz);
    this.passHiHz = Math.round(hiHz);
    this.opts.onStatus?.(`setPassband lo=${this.passLoHz} hi=${this.passHiHz} csdr=${this.csdr ? 'live' : 'null'}`);
    if (this.csdr) this.csdr.setPassband(this.passLoHz, this.passHiHz);
  }

  /** Number of FIR taps in the csdr bandpass channel filter. */
  setBandpassTaps(n) {
    if (!Number.isFinite(n) || n < 50) return;
    this.bandpassTaps = Math.round(n);
    this.opts.onStatus?.(`setBandpassTaps n=${this.bandpassTaps} csdr=${this.csdr ? 'live' : 'null'}`);
    if (this.csdr) this.csdr.setBandpassTaps(this.bandpassTaps);
  }

  /** Live frequency shift in Hz — passed straight to csdr's
   *  shift_addition_cc via its --fifo control. No pipeline rebuild,
   *  no audio gap. Used when the user dials off the SpyServer's
   *  current tune within the IQ window. */
  setShiftHz(hz) {
    if (!Number.isFinite(hz)) return;
    this.shiftHz = Math.round(hz);
    const rate = (this.srOut > 0) ? (-this.shiftHz / this.srOut) : 0;
    this.opts.onStatus?.(`setShiftHz hz=${this.shiftHz} srOut=${this.srOut} rate=${rate.toFixed(6)} csdr=${this.csdr ? 'live' : 'null'}`);
    if (this.csdr && this.srOut) {
      this.csdr.setShift(rate);
    }
  }

  /** Set fixed post-demod gain (applied when AGC is 'off'). */
  setFixedGain(g) {
    if (!Number.isFinite(g) || g <= 0) return;
    this.fixedGain = g;
    this.opts.onStatus?.(`setFixedGain g=${this.fixedGain} csdr=${this.csdr ? 'live' : 'null'}`);
    if (this.csdr) this.csdr.setFixedGain(this.fixedGain);
  }

  /** Set csdr's audio AGC profile. 'off' drops the agc_ff stage. */
  setAgcProfile(profile) {
    const allowed = new Set(['off', 'fast', 'med', 'slow']);
    const p = String(profile || '').toLowerCase();
    if (!allowed.has(p)) return;
    this.agcProfile = p;
    this.opts.onStatus?.(`setAgcProfile profile=${this.agcProfile} csdr=${this.csdr ? 'live' : 'null'}`);
    if (this.csdr) this.csdr.setAgcProfile(this.agcProfile);
  }

  /** Switch demod mode at runtime — sends SETTING_AUDIO_DEMOD_MODE.
   *  `mode` is a radiom mode string ('am' / 'usb' / 'lsb' / 'cw' /
   *  'nbfm' / 'wfm'); we map to the SpyServer enum here. */
  setMode(mode) {
    const m = String(mode || '').toLowerCase();
    const demod = MODE_TO_DEMOD[m];
    if (demod == null) return;
    this.demodMode = demod;
    if (this.gotSync) this.setSettingU32(SETTING_AUDIO_DEMOD_MODE, this.demodMode);
    // Tell the csdr pipeline to rebuild with the new demod chain.
    if (this.csdr) this.csdr.setMode(m);
  }

  /** Audio bandwidth in Hz — drives the IQ decimation stage so the
   *  upstream IQ rate scales with the user's chosen BW. Narrower BW
   *  → narrower IQ rate → less noise + less proxy bandwidth.
   *
   *  Re-runs configureStream which pauses STREAMING_ENABLED, reapplies
   *  IQ_DECIMATION, and resumes. Emits a fresh hello so the client can
   *  update its IqListenDemod input rate. */
  setBandwidthHz(hz) {
    if (!Number.isFinite(hz) || hz <= 0) return;
    const next = Math.round(hz);
    if (next === this.audioBwHz) return;
    this.audioBwHz = next;
    if (this.gotSync) {
      // Keep the AUDIO_BANDWIDTH setting too — harmless even though
      // server-side audio mode isn't what we use.
      this.setSettingU32(SETTING_AUDIO_BANDWIDTH, this.audioBwHz);
      // Pause streaming, reapply settings (which picks a new decim
      // stage based on the new BW), resume.
      this.setSettingU32(SETTING_STREAMING_ENABLED, 0);
      this.configureStream(
        this.pendingFreqHz ?? Math.max(0, Math.min(this.maxHz, this.minHz + 1_000_000)),
        this.pendingGain ?? null,
      );
    }
  }

  /** Switch stream mode (AUDIO / IQ / FFT bitfield). Re-applies all
   *  settings the new mode needs and enables streaming.
   *  Note: SpyServer needs STREAMING_ENABLED toggled when mode changes
   *  on some implementations — we do it inside configureStream. */
  setStreamMode(streamMode) {
    if (!Number.isFinite(streamMode)) return;
    this.streamMode = streamMode | 0;
    if (this.gotSync) {
      // Pause briefly, reconfigure, resume.
      this.setSettingU32(SETTING_STREAMING_ENABLED, 0);
      this.configureStream(
        this.pendingFreqHz ?? Math.max(0, Math.min(this.maxHz, this.minHz + 1_000_000)),
        this.pendingGain ?? null,
      );
    }
  }

  close() {
    this.closed = true;
    if (this.pingTimer != null) { clearInterval(this.pingTimer); this.pingTimer = null; }
    // destroy() unlinks the shift control fifo from /tmp — important
    // so we don't leak fifo files across sessions.
    try { this.csdr?.destroy(); } catch {}
    this.csdr = null;
    try { this.setSettingU32(SETTING_STREAMING_ENABLED, 0); } catch {}
    try { this.sock?.end(); } catch {}
    this.sock = null;
  }
}
