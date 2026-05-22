/** WebSocket client for the server-side fldigi-vendored FSQ decoder. */

export interface FsqFldigiOpts {
  sampleRate: number;
  carrierHz: number;
  baud: number;        // 1.5 / 2 / 3 / 4.5 / 6
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class FsqFldigiDecoder {
  private ws: WebSocket | null = null;
  private opts: FsqFldigiOpts;
  private queue: Int16Array[] = [];

  constructor(opts: FsqFldigiOpts) {
    this.opts = opts;
    this.connect();
  }

  setCarrierHz(hz: number) {
    this.opts = { ...this.opts, carrierHz: hz };
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connect();
  }
  setBaud(b: number) {
    this.opts = { ...this.opts, baud: b };
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
    q.set('carrier', String(Math.round(this.opts.carrierHz)));
    q.set('baud',    String(this.opts.baud));
    const url = `${proto}//${location.host}/ws/decode/fsq-fldigi?${q.toString()}`;
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
