// rtl_tcp bridge — Node TCP↔WebSocket proxy that talks to a remote
// `rtl_tcp` server (Raspberry Pi + RTL-SDR dongle is the canonical
// setup) and presents the stream to the browser as Kiwi-shaped frames.
//
// rtl_tcp wire protocol (Stephen Markgraf, public-domain reference):
//   ─ Server → Client ─
//     12-byte header on first connect:
//       'R','T','L','0'   (magic)
//       tuner_type   uint32 BE
//       tuner_gains  uint32 BE   (number of valid gain steps)
//     Then continuous stream of unsigned 8-bit I/Q interleaved
//     samples at the negotiated rate (default 2.048 MS/s).
//   ─ Client → Server ─
//     5-byte commands:
//       0x01 set freq          uint32 BE Hz
//       0x02 set sample rate   uint32 BE Hz
//       0x03 set gain mode     0=auto, 1=manual
//       0x04 set gain          int32 BE tenths-of-dB
//       0x05 set freq corr     int32 BE ppm
//       0x06 set if-stage gain (stage<<16 | gain)
//       0x07 set test mode     0/1
//       0x08 set agc mode      0/1
//       0x09 set direct sampling 0/1/2
//       0x0a set offset tuning 0/1
//
// We can't pump 4 MB/s of raw IQ through a WebSocket, so the bridge
// decimates server-side to a manageable rate (default 250 kS/s — 1 MB/s)
// before forwarding. The client receives:
//   ◄ JSON  { t:"hello", tunerType, gains, srInput, srOut }
//   ◄ JSON  { t:"status", msg:"..." }
//   ◄ binary IQ frames: int16 LE I/Q interleaved at srOut
//     (we lift from 8-bit unsigned [0..255] to int16 LE [-32768..+32767]
//      so the player's IQ path can reuse the existing 16-bit pipeline)
//   ► JSON  { t:"freq", hz } | { t:"rate", hz } | { t:"gain", db } |
//           { t:"agc", on } | { t:"decim", ratio }

import net from 'node:net';

const HEADER_LEN = 12;
const DEFAULT_SR = 2_048_000;
const DEFAULT_OUT_SR = 250_000;

export class RtlTcpBridge {
  /**
   * @param {object} opts
   * @param {string} opts.host       rtl_tcp server hostname
   * @param {number} opts.port       rtl_tcp server port (default 1234)
   * @param {(buf: Buffer) => void}  opts.onIq       called with decimated int16 LE IQ
   * @param {(info: object) => void} [opts.onHello]
   * @param {(msg: string) => void}  [opts.onStatus]
   */
  constructor(opts) {
    this.opts = opts;
    this.sock = null;
    this.closed = false;
    this.headerBuf = Buffer.alloc(0);
    this.gotHeader = false;
    this.srInput = DEFAULT_SR;
    this.srOut = DEFAULT_OUT_SR;
    this.decim = Math.max(1, Math.floor(this.srInput / this.srOut));
    // Simple FIR-less integer decimator state — we average `decim`
    // I/Q samples into one output. Cheap and aliasing-prone but for
    // narrowband HF/VHF use (a few kHz of audio inside a 250 kS/s
    // slice) it's adequate. Replace with a halfband FIR if quality
    // matters more than CPU.
    this.decPhase = 0;
    this.decAccI = 0;
    this.decAccQ = 0;
    /** Output sample format. Default 'int16' (LE) — matches the
     *  --iformat SC16 / --sample-format S16 invocation of every
     *  vendored binary downstream. Some decoders (dump978) only
     *  accept raw 8-bit unsigned (UC8); for those, switch via
     *  setOutFormat('uc8') to skip the 8→16 lift. */
    this.outFormat = 'int16';
    this.connect();
  }

  connect() {
    this.sock = net.createConnection({ host: this.opts.host, port: this.opts.port }, () => {
      this.opts.onStatus?.(`connected to rtl_tcp ${this.opts.host}:${this.opts.port}`);
    });
    this.sock.on('data', (chunk) => this.consume(chunk));
    this.sock.on('error', (err) => this.opts.onStatus?.(`rtl_tcp error: ${err.message}`));
    this.sock.on('close', () => {
      this.opts.onStatus?.('rtl_tcp closed');
      this.sock = null;
    });
  }

  consume(chunk) {
    if (!this.gotHeader) {
      this.headerBuf = Buffer.concat([this.headerBuf, chunk]);
      if (this.headerBuf.length < HEADER_LEN) return;
      const magic = this.headerBuf.subarray(0, 4).toString('ascii');
      if (magic !== 'RTL0') {
        this.opts.onStatus?.(`bad rtl_tcp magic: ${magic}`);
        try { this.sock?.destroy(); } catch {}
        return;
      }
      const tunerType = this.headerBuf.readUInt32BE(4);
      const gains     = this.headerBuf.readUInt32BE(8);
      this.gotHeader = true;
      this.opts.onHello?.({
        tunerType,
        gains,
        srInput: this.srInput,
        srOut: this.srOut,
      });
      // Anything after the 12-byte header is IQ payload.
      const tail = this.headerBuf.subarray(HEADER_LEN);
      this.headerBuf = Buffer.alloc(0);
      if (tail.length) this.processIq(tail);
      return;
    }
    this.processIq(chunk);
  }

  /** Decimate the 8-bit-unsigned IQ stream by `decim`, lift to 16-bit
   *  signed, and forward to the client. Uses a running boxcar average
   *  — cheap, no FIR. Phase persists across calls so chunks don't
   *  cause discontinuities. */
  processIq(buf) {
    if (!this.gotHeader) return;
    const inLen = buf.length & ~1;             // even number of bytes
    if (inLen === 0) return;
    const decim = this.decim;
    let phase = this.decPhase;
    let accI = this.decAccI, accQ = this.decAccQ;
    const uc8 = this.outFormat === 'uc8';
    // int16 path: 4 output bytes per IQ pair. uc8 path: 2 bytes.
    const bytesPerOut = uc8 ? 2 : 4;
    const outBytes = Math.ceil(inLen / 2 / decim) * bytesPerOut + 8;
    const out = Buffer.allocUnsafe(outBytes);
    let w = 0;
    for (let i = 0; i < inLen; i += 2) {
      // Sum the raw 8-bit unsigned samples directly so the boxcar
      // average preserves the original unsigned scale; we centre on
      // 128 only at lift-to-int16 time.
      accI += buf[i];
      accQ += buf[i + 1];
      phase++;
      if (phase >= decim) {
        const meanI = (accI / decim) | 0;     // 0..255
        const meanQ = (accQ / decim) | 0;
        if (uc8) {
          out[w++] = meanI;
          out[w++] = meanQ;
        } else {
          const i16I = (meanI - 128) * 256;
          const i16Q = (meanQ - 128) * 256;
          out.writeInt16LE(Math.max(-32768, Math.min(32767, i16I)), w);  w += 2;
          out.writeInt16LE(Math.max(-32768, Math.min(32767, i16Q)), w);  w += 2;
        }
        accI = 0; accQ = 0; phase = 0;
      }
    }
    this.decPhase = phase;
    this.decAccI = accI; this.decAccQ = accQ;
    if (w > 0) this.opts.onIq?.(out.subarray(0, w));
  }

  /** Switch the WS output format. Call before activating a decoder
   *  that only accepts UC8 (dump978). Default is 'int16'. */
  setOutFormat(fmt) {
    if (fmt === 'uc8' || fmt === 'int16') this.outFormat = fmt;
  }

  // ── control commands (5-byte, BE) ──
  cmd(id, arg32) {
    if (!this.sock) return;
    const b = Buffer.alloc(5);
    b[0] = id;
    b.writeUInt32BE(arg32 >>> 0, 1);
    try { this.sock.write(b); } catch {}
  }
  setFreq(hz)       { this.cmd(0x01, hz | 0); }
  setSampleRate(hz) {
    this.cmd(0x02, hz | 0);
    this.srInput = hz;
    this.decim = Math.max(1, Math.floor(this.srInput / this.srOut));
  }
  setGainMode(manual) { this.cmd(0x03, manual ? 1 : 0); }
  setGain(tenthDb)    { this.cmd(0x04, tenthDb | 0); }
  setFreqCorr(ppm)    { this.cmd(0x05, ppm | 0); }
  setAgcMode(on)      { this.cmd(0x08, on ? 1 : 0); }
  setDirectSampling(m) { this.cmd(0x09, m | 0); }
  setOffsetTuning(on) { this.cmd(0x0a, on ? 1 : 0); }
  /** Choose the *output* sample rate after decimation. */
  setOutRate(hz) {
    this.srOut = Math.max(1, hz | 0);
    this.decim = Math.max(1, Math.floor(this.srInput / this.srOut));
  }

  close() {
    this.closed = true;
    try { this.sock?.destroy(); } catch {}
    this.sock = null;
  }
}
