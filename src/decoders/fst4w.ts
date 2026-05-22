/** WebSocket client for the server-side FST4W (beacon) decoder.
 *
 *  Wire shape identical to the FST4 client; backend just runs the
 *  shared `fst4d` binary with the extra `-W` flag for beacon-mode
 *  decoding. Optional `periodSec` selects the FST4W submode
 *  (60/120/300/900/1800; default 120, the WSPR-aligned 2-min slot). */

import type { Fst4Spot } from './fst4';

export type Fst4wSpot = Fst4Spot;

export interface Fst4wDecoderOpts {
  sampleRate: number;
  dialKHz?: number;
  periodSec?: number;
  onSpot?: (s: Fst4wSpot) => void;
  onStatus?: (s: string) => void;
}

export class Fst4wDecoder {
  private ws: WebSocket | null = null;
  private opts: Fst4wDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: Fst4wDecoderOpts) {
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
    const url = `${proto}//${location.host}/ws/decode/fst4w${q.toString() ? '?' + q.toString() : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    const period = this.opts.periodSec ?? 120;
    ws.onopen = () => { this.opts.onStatus?.(`listening (${period}-s slots)`); this.flushQueue(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: { t?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'spot') this.opts.onSpot?.(msg as Fst4wSpot);
      else if (msg.t === 'status' && typeof (msg as { msg?: unknown }).msg === 'string')
        this.opts.onStatus?.((msg as { msg: string }).msg);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
