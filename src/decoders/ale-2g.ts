/** WebSocket client for the server-side ALE 2G (MIL-STD-188-141B) decoder.
 *  Streams 12 kHz int16 PCM up the WS, receives decoded lines back. Each
 *  line is a complete ALE word like "[12:34:56] [TO] ABC". */

export interface ALE2GDecoderOpts {
  sampleRate: number;
  onLine?: (line: string) => void;
  onStatus?: (s: string) => void;
}

export class ALE2GDecoder {
  private ws: WebSocket | null = null;
  private opts: ALE2GDecoderOpts;
  private queue: Int16Array[] = [];
  private buf = '';

  constructor(opts: ALE2GDecoderOpts) {
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
    this.ws!.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }
  private flushQueue() {
    while (this.queue.length) this.send(this.queue.shift()!);
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/decode/ale-2g`;
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
      this.buf += text;
      let nl;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).replace(/\r$/, '');
        this.buf = this.buf.slice(nl + 1);
        if (line.length > 0) this.opts.onLine?.(line);
      }
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
