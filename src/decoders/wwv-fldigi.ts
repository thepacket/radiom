/** WebSocket client for the server-side fldigi-vendored WWV scope. The
 *  server forwards each 1000- or 200-byte video frame as a single binary
 *  WS message; we hand it to onFrame as Uint8Array. */

export interface WwvFldigiOpts {
  sampleRate: number;
  onFrame?: (frame: Uint8Array) => void;
  onStatus?: (s: string) => void;
}

export class WwvFldigiDecoder {
  private ws: WebSocket | null = null;
  private opts: WwvFldigiOpts;
  private queue: Int16Array[] = [];

  constructor(opts: WwvFldigiOpts) {
    this.opts = opts;
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
    const url = `${proto}//${location.host}/ws/decode/wwv-fldigi`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.opts.onStatus?.('listening…');
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') return;
      const ab = e.data as ArrayBuffer;
      this.opts.onFrame?.(new Uint8Array(ab));
    };
    ws.onerror  = () => this.opts.onStatus?.('error');
    ws.onclose  = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
