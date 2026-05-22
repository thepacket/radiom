/** WebSocket client for the server-side JS8Call decoder.
 *
 *  JS8 runs in 15-second slots aligned to UTC seconds %15. Server
 *  handles slot timing + js8 spawn; the client streams 12 kHz int16
 *  PCM and consumes JSON spot/status messages back. */

export interface Js8Spot {
  t: 'spot';
  time: string;       // UTC HHMMSS
  snrDb: number;
  dtSec: number;
  freqHz: number;     // audio offset
  freqMHz: number;    // dial + offset / 1000  (0 if dial unknown)
  message: string;
}

export interface Js8DecoderOpts {
  sampleRate: number;
  dialKHz?: number;
  onSpot?: (s: Js8Spot) => void;
  onStatus?: (s: string) => void;
}

export class Js8Decoder {
  private ws: WebSocket | null = null;
  private opts: Js8DecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: Js8DecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  feed(samples: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(new Int16Array(samples));
      // 15-second working set is small; cap queue at ~30 frames worth.
      if (this.queue.length > 30) this.queue.shift();
      return;
    }
    this.flushQueue();
    this.send(samples);
  }

  setDial(kHz: number) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'dial', kHz }));
    }
    this.opts.dialKHz = kHz;
  }

  /** Tell the server to discard any in-progress capture and start a
   *  new slot RIGHT NOW (skipping UTC-multiple-of-15-s alignment). */
  triggerNow() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'trigger' }));
    }
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  private send(samples: Int16Array) {
    const buf = new ArrayBuffer(samples.byteLength);
    new Uint8Array(buf).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.ws!.send(buf);
  }
  private flushQueue() {
    while (this.queue.length) this.send(this.queue.shift()!);
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    if (this.opts.dialKHz) q.set('dial', String(this.opts.dialKHz));
    const url = `${proto}//${location.host}/ws/decode/js8${q.toString() ? '?' + q.toString() : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.opts.onStatus?.('listening (15-s slots)'); this.flushQueue(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: { t?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'spot') this.opts.onSpot?.(msg as Js8Spot);
      else if (msg.t === 'status' && typeof (msg as { msg?: unknown }).msg === 'string')
        this.opts.onStatus?.((msg as { msg: string }).msg);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
