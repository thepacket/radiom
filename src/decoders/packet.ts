/** WebSocket client for the server-side direwolf-vendored HF AX.25 / APRS
 *  packet decoder. Streams 12 kHz int16 PCM up the WS; receives decoded
 *  frame text lines back down. */

export interface PacketDecoderOpts {
  sampleRate: number;
  onLine?: (line: string) => void;
  onStatus?: (s: string) => void;
}

export class PacketDecoder {
  private ws: WebSocket | null = null;
  private opts: PacketDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: PacketDecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  feed(samples: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(new Int16Array(samples));
      if (this.queue.length > 200) this.queue.shift();
      return;
    }
    this.flushQueue();
    this.send(samples);
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  private send(samples: Int16Array) {
    // Copy into a fresh ArrayBuffer in case the underlying is a
    // SharedArrayBuffer (AudioWorklet input) which WebSocket.send rejects.
    const buf = new ArrayBuffer(samples.byteLength);
    new Uint8Array(buf).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.ws!.send(buf);
  }
  private flushQueue() {
    while (this.queue.length) this.send(this.queue.shift()!);
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/decode/packet`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.opts.onStatus?.('listening…'); this.flushQueue(); };
    ws.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : '';
      if (!text) return;
      this.opts.onLine?.(text);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
