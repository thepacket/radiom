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

// Streaming modes (bitfield)
const STREAM_MODE_IQ_ONLY        = 0x01;
// (AUDIO_ONLY = 0x02, FFT_ONLY = 0x04 — not used in first-cut)

// IQ format IDs
const FORMAT_INT16 = 2;

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
   * @param {(buf: Buffer) => void}  opts.onIq      — int16 LE IQ
   * @param {(info: object) => void} [opts.onHello]
   * @param {(msg: string) => void}  [opts.onStatus]
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
    this.connect();
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
  configureIqStream(freqHz, gainIdx) {
    if (!this.gotDeviceInfo) return;
    this.decimStage = pickDecimationStage(this.maxSr, 250_000);
    this.srOut = Math.max(1, Math.round(this.maxSr / (1 << this.decimStage)));
    const clampedHz = Math.max(this.minHz || 0, Math.min(this.maxHz || 0xffffffff, freqHz | 0));
    // Send in the order SDR++ uses — format/freq/decim/gain first, then
    // STREAMING_MODE, then STREAMING_ENABLED.
    this.setSettingU32(SETTING_IQ_FORMAT,       FORMAT_INT16);
    this.setSettingU32(SETTING_IQ_FREQUENCY,    clampedHz);
    this.setSettingU32(SETTING_IQ_DECIMATION,   this.decimStage);
    if (gainIdx != null) this.setSettingU32(SETTING_GAIN, Math.max(0, gainIdx | 0));
    this.setSettingU32(SETTING_STREAMING_MODE,    STREAM_MODE_IQ_ONLY);
    this.setSettingU32(SETTING_STREAMING_ENABLED, 1);
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
      // Higher-bit IQ + FFT/audio formats we don't request — log if
      // they ever appear so the wiring is debuggable.
      case SRV_MSG_INT24_IQ:
      case SRV_MSG_FLOAT_IQ:
      case SRV_MSG_UINT8_FFT:
      case SRV_MSG_INT16_FFT:
      case SRV_MSG_UINT8_AUDIO:
      case SRV_MSG_INT16_AUDIO:
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
    const out = Buffer.allocUnsafe(body.length * 2);
    for (let i = 0; i < body.length; i++) {
      const v = (body[i] - 128) * 256;
      out[i * 2]     = (v >> 8) & 0xff;       // high byte first (BE)
      out[i * 2 + 1] = v        & 0xff;
    }
    this.opts.onIq?.(out);
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
      this.configureIqStream(
        this.pendingFreqHz ?? Math.max(0, Math.min(this.maxHz, this.minHz + 1_000_000)),
        this.pendingGain ?? Math.floor(this.maxGain * 0.6),
      );
    }
  }

  onInt16Iq(body) {
    if (body.length < 4) return;
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

  // ── External control ──────────────────────────────────────────────

  setFreq(hz) {
    this.pendingFreqHz = hz | 0;
    if (this.gotSync) this.setSettingU32(SETTING_IQ_FREQUENCY, this.pendingFreqHz);
  }
  setGainIndex(idx) {
    this.pendingGain = Math.max(0, idx | 0);
    if (this.gotSync) this.setSettingU32(SETTING_GAIN, this.pendingGain);
  }

  close() {
    this.closed = true;
    if (this.pingTimer != null) { clearInterval(this.pingTimer); this.pingTimer = null; }
    try { this.setSettingU32(SETTING_STREAMING_ENABLED, 0); } catch {}
    try { this.sock?.end(); } catch {}
    this.sock = null;
  }
}
