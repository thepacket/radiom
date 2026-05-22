/** WebSocket client for the server-side fldigi-vendored PSK decoder
 *  (BPSK31 by default). Same shape as PSKDecoder. */

export type PSKFldigiMode =
  | 'bpsk31' | 'bpsk63' | 'bpsk63f' | 'bpsk125' | 'bpsk250' | 'bpsk500' | 'bpsk1000'
  | 'qpsk31' | 'qpsk63' | 'qpsk125' | 'qpsk250' | 'qpsk500'
  | '8psk125' | '8psk125fl' | '8psk125f'
  | '8psk250' | '8psk250fl' | '8psk250f'
  | '8psk500' | '8psk500f'
  | '8psk1000' | '8psk1000f' | '8psk1200f'
  | 'psk125r' | 'psk250r' | 'psk500r' | 'psk1000r';

export interface PSKFldigiDecoderOpts {
  sampleRate: number;
  pitchHz?: number;
  mode?: PSKFldigiMode;
  acqSn?: number;
  searchRange?: number;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class PSKFldigiDecoder {
  private ws: WebSocket | null = null;
  private opts: PSKFldigiDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: PSKFldigiDecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  setPitch(hz: number) {
    this.opts = { ...this.opts, pitchHz: hz };
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connect();
  }

  setMode(mode: PSKFldigiMode) {
    this.opts = { ...this.opts, mode };
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connect();
  }

  feed(samples: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(new Int16Array(samples));
      if (this.queue.length > 200) this.queue.shift();
      return;
    }
    while (this.queue.length) this.send(this.queue.shift()!);
    this.send(samples);
  }

  close() { try { this.ws?.close(); } catch {} this.ws = null; }

  private send(samples: Int16Array) {
    this.ws!.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    if (this.opts.pitchHz)        q.set('pitch',  String(this.opts.pitchHz));
    if (this.opts.mode)           q.set('mode',   this.opts.mode);
    if (this.opts.acqSn != null)  q.set('acqsn',  String(this.opts.acqSn));
    if (this.opts.searchRange)    q.set('search', String(this.opts.searchRange));
    const qs = q.toString();
    const url = `${proto}//${location.host}/ws/decode/psk-fldigi${qs ? '?' + qs : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.opts.onStatus?.('listening…');
    ws.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : '';
      if (!text) return;
      for (const ch of text) this.opts.onChar?.(ch);
    };
    ws.onerror  = () => this.opts.onStatus?.('error');
    ws.onclose  = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
