import type { AudioFrame, WaterfallFrame } from './types';

/** Build the two WS URLs for a Kiwi server. The timestamp is any monotonic
 *  number — it just prevents proxy caching. Plain ws:// for now; wss:// would
 *  require Kiwi behind TLS reverse proxy. */
export function buildUrls(host: string, port: number, _secure = false, prefix = '') {
  // QiwiQ uses millisecond timestamps (Date.now() = 13 digits), not seconds.
  const ts = Date.now();
  const p = prefix ? `/${prefix}` : '';
  // ALWAYS route through our /ws proxy — even on plain HTTP. The proxy
  // sets `Origin: null` in the upstream WS handshake, which the Kiwi
  // v1.817+ bot detector requires. A direct browser ws:// connection
  // would send `Origin: http://hostname`, which the detector flags.
  if (typeof location !== 'undefined') {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = `${scheme}//${location.host}/ws/${host}:${port}`;
    return {
      snd: `${base}${p}/${ts}/SND`,
      wf:  `${base}${p}/${ts}/W/F`,
    };
  }
  // SSR / unit-test fallback.
  return {
    snd: `ws://${host}:${port}${p}/${ts}/SND`,
    wf:  `ws://${host}:${port}${p}/${ts}/W/F`,
  };
}

/** URL path variants seen across Kiwi firmware versions. */
export const URL_PREFIXES = ['kiwi', ''] as const;

/** Frames from the server: 3-byte ASCII tag + 1 byte (often 0) + body.
 *  Tags observed: 'MSG' (text, &-separated url-encoded k=v pairs),
 *                 'SND' (audio frame),
 *                 'W/F' (waterfall frame). */
export type Frame =
  | { tag: 'MSG'; kv: Record<string, string> }
  | { tag: 'SND'; audio: AudioFrame }
  | { tag: 'W/F'; wf: WaterfallFrame }
  | { tag: 'UNK'; raw: Uint8Array };

const td = new TextDecoder('latin1');

export function parseFrame(buf: ArrayBuffer): Frame {
  const u8 = new Uint8Array(buf);
  if (u8.length < 4) return { tag: 'UNK', raw: u8 };
  const tag = td.decode(u8.subarray(0, 3));
  // Header layout differs by tag:
  //   MSG → "MSG " + text     (4-byte header: tag+space)
  //   W/F → "W/F " + binary   (4-byte header: tag+space)
  //   SND → "SND" + flags...  (3-byte header: NO spacer; byte 3 IS the flags)
  // Getting this wrong by one byte makes int16-BE samples decode as garbage.
  const bodyOffset = tag === 'SND' ? 3 : 4;
  const body = u8.subarray(bodyOffset);

  if (tag === 'MSG') {
    const text = td.decode(body);
    const kv: Record<string, string> = {};
    for (const part of text.split(' ')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq < 0) { kv[part] = ''; continue; }
      const k = part.slice(0, eq);
      const v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
      kv[k] = v;
    }
    return { tag: 'MSG', kv };
  }

  if (tag === 'SND') {
    // body: flags(u8) | seq(u32 BE) | smeter(u16 BE) | samples...
    if (body.length < 7) return { tag: 'UNK', raw: u8 };
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const flags = dv.getUint8(0);
    const seq = dv.getUint32(1, false);
    const smeter = dv.getUint16(5, false);
    const rssiDbm = 0.1 * smeter - 127;
    const payload = body.subarray(7);
    // Distinguish PCM vs ADPCM by payload size: int16 PCM at 12kHz with the
    // standard 512-sample frame is exactly 1024 bytes (even). ADPCM packs
    // 2 samples/byte so the same 512 samples = 256 bytes. Anything not
    // matching the PCM layout is treated as compressed.
    const adpcm = (payload.length & 1) !== 0 || payload.length < 1024;
    return { tag: 'SND', audio: { seq, smeter, rssiDbm, flags, payload, adpcm } };
  }

  if (tag === 'W/F') {
    // body: x_bin_server(u32 LE) | flags(u32 LE) | seq(u32 LE) | bins...
    if (body.length < 12) return { tag: 'UNK', raw: u8 };
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const xBinServer = dv.getUint32(0, true);
    const flags = dv.getUint32(4, true);
    const seq = dv.getUint32(8, true);
    const bins = body.subarray(12);
    return { tag: 'W/F', wf: { xBinServer, flags, seq, bins } };
  }

  return { tag: 'UNK', raw: u8 };
}

/** Decode int16 big-endian PCM payload to Float32 in [-1, 1]. */
export function decodePcmBe(payload: Uint8Array): Float32Array {
  const n = payload.length >> 1;
  const out = new Float32Array(n);
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < n; i++) {
    out[i] = dv.getInt16(i * 2, false) / 32768;
  }
  return out;
}
