/** WebSocket client for the server-side fldigi-vendored Olivia decoder. */

export interface OliviaFldigiOpts {
  sampleRate: number;
  tones: number;
  bandwidth: number;
  carrierHz: number;
  smargin?: number;
  sinteg?: number;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class OliviaFldigiDecoder {
  private ws: WebSocket | null = null;
  private opts: OliviaFldigiOpts;
  private queue: Int16Array[] = [];

  constructor(opts: OliviaFldigiOpts) {
    this.opts = opts;
    this.connect();
  }

  setMode(tones: number, bandwidth: number) {
    this.opts = { ...this.opts, tones, bandwidth };
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
  clear() {} // text panel handles clearing; nothing decoder-side

  private send(samples: Int16Array) {
    this.ws!.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    q.set('tones',     String(this.opts.tones));
    q.set('bandwidth', String(this.opts.bandwidth));
    q.set('carrier',   String(this.opts.carrierHz));
    if (this.opts.smargin != null) q.set('smargin', String(this.opts.smargin));
    if (this.opts.sinteg  != null) q.set('sinteg',  String(this.opts.sinteg));
    const url = `${proto}//${location.host}/ws/decode/olivia-fldigi?${q.toString()}`;
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
