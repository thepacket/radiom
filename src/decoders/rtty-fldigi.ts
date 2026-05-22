/** WebSocket client for the server-side fldigi-vendored RTTY decoder. */

export interface RTTYFldigiOpts {
  sampleRate: number;
  carrierHz: number;
  /** Symbol rate. Default 45.45. */
  baud?: number;
  /** Mark/space shift in Hz. Default 170. */
  shift?: number;
  /** Data bits: 5, 7, or 8. Default 5 (Baudot). */
  bits?: number;
  /** Stop bits: 1, 1.5, or 2. Default 1.5. */
  stop?: number;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class RTTYFldigiDecoder {
  private ws: WebSocket | null = null;
  private opts: RTTYFldigiOpts;
  private queue: Int16Array[] = [];

  constructor(opts: RTTYFldigiOpts) {
    this.opts = opts;
    this.connect();
  }

  setCarrierHz(hz: number) { this.reconfigure({ carrierHz: hz }); }
  setPreset(p: { baud?: number; shift?: number; bits?: number; stop?: number; carrierHz?: number }) {
    this.reconfigure(p);
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

  private reconfigure(p: Partial<RTTYFldigiOpts>) {
    this.opts = { ...this.opts, ...p };
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connect();
  }

  private send(samples: Int16Array) {
    this.ws!.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    q.set('carrier', String(Math.round(this.opts.carrierHz)));
    if (this.opts.baud)  q.set('baud',  String(this.opts.baud));
    if (this.opts.shift) q.set('shift', String(this.opts.shift));
    if (this.opts.bits)  q.set('bits',  String(this.opts.bits));
    if (this.opts.stop)  q.set('stop',  String(this.opts.stop));
    const url = `${proto}//${location.host}/ws/decode/rtty-fldigi?${q.toString()}`;
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
