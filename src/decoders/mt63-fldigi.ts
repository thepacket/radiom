/** WebSocket client for the server-side fldigi-vendored MT63 decoder. */

export type Mt63Mode = '500s' | '500l' | '1000s' | '1000l' | '2000s' | '2000l';

export interface Mt63FldigiOpts {
  sampleRate: number;
  mode: Mt63Mode;
  carrierHz: number;
  integration?: 'short' | 'long';
  eightBit?: boolean;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class Mt63FldigiDecoder {
  private ws: WebSocket | null = null;
  private opts: Mt63FldigiOpts;
  private queue: Int16Array[] = [];

  constructor(opts: Mt63FldigiOpts) {
    this.opts = opts;
    this.connect();
  }

  setMode(mode: Mt63Mode) {
    this.opts = { ...this.opts, mode };
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connect();
  }
  setCarrierHz(hz: number) {
    this.opts = { ...this.opts, carrierHz: hz };
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
  clear() {}

  private send(samples: Int16Array) {
    this.ws!.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    q.set('mode',    this.opts.mode);
    q.set('carrier', String(Math.round(this.opts.carrierHz)));
    if (this.opts.integration) q.set('integration', this.opts.integration);
    if (this.opts.eightBit != null) q.set('8bit', this.opts.eightBit ? '1' : '0');
    const url = `${proto}//${location.host}/ws/decode/mt63-fldigi?${q.toString()}`;
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
