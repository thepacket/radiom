/** WebSocket client for the server-side Q65 decoder.
 *
 *  Q65 is the modern WSJT-X weak-signal mode, decoded by the same `jt9`
 *  binary with the `-q -p <T>` flags. Period defaults to 60 s
 *  (Q65-60). Wire protocol identical to the JT9 / JT65 clients. */

import type { Jt9Spot } from './jt9';

export type Q65Spot = Jt9Spot;

export interface Q65DecoderOpts {
  sampleRate: number;
  dialKHz?: number;
  /** Slot duration in seconds — 15 / 30 / 60 / 120 / 300. Default 60. */
  periodSec?: number;
  onSpot?: (s: Q65Spot) => void;
  onStatus?: (s: string) => void;
}

export class Q65Decoder {
  private ws: WebSocket | null = null;
  private opts: Q65DecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: Q65DecoderOpts) {
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
    if (this.opts.periodSec) q.set('period', String(this.opts.periodSec));
    const url = `${proto}//${location.host}/ws/decode/q65${q.toString() ? '?' + q.toString() : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    const periodTxt = this.opts.periodSec ? `${this.opts.periodSec}-s slots` : '1-min slots';
    ws.onopen = () => { this.opts.onStatus?.(`listening (${periodTxt})`); this.flushQueue(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: { t?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'spot') this.opts.onSpot?.(msg as Q65Spot);
      else if (msg.t === 'status' && typeof (msg as { msg?: unknown }).msg === 'string')
        this.opts.onStatus?.((msg as { msg: string }).msg);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
