/** WebSocket client for the server-side JT4 decoder.
 *
 *  JT4 runs in 1-minute UTC-aligned slots, decoded by the shared
 *  `jt9` binary with the `-4` flag. Wire protocol matches the JT9 /
 *  JT65 / Q65 clients. */

import type { Jt9Spot } from './jt9';

export type Jt4Spot = Jt9Spot;

export interface Jt4DecoderOpts {
  sampleRate: number;
  dialKHz?: number;
  onSpot?: (s: Jt4Spot) => void;
  onStatus?: (s: string) => void;
}

export class Jt4Decoder {
  private ws: WebSocket | null = null;
  private opts: Jt4DecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: Jt4DecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  feed(samples: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(new Int16Array(samples));
      if (this.queue.length > 50) this.queue.shift();
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
    const url = `${proto}//${location.host}/ws/decode/jt4${q.toString() ? '?' + q.toString() : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.opts.onStatus?.('listening (1-min slots)'); this.flushQueue(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: { t?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'spot') this.opts.onSpot?.(msg as Jt4Spot);
      else if (msg.t === 'status' && typeof (msg as { msg?: unknown }).msg === 'string')
        this.opts.onStatus?.((msg as { msg: string }).msg);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
