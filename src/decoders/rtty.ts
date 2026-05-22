/** WebSocket client for the server-side RTTY decoder.
 *  Same shape as CWDecoder so shell wiring is uniform. */

export interface RTTYDecoderOpts {
  sampleRate: number;
  /** Audio frequency of the mark tone (Hz). Default 915. */
  markHz?: number;
  /** Audio frequency of the space tone (Hz). Default 1085. */
  spaceHz?: number;
  /** Symbol rate. Default 45.45. */
  baud?: number;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class RTTYDecoder {
  private ws: WebSocket | null = null;
  private opts: RTTYDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: RTTYDecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  /** Reconfigure pitch/baud — drops the WS and reconnects with new query. */
  setPreset(p: { markHz?: number; spaceHz?: number; baud?: number }) {
    this.opts = { ...this.opts, ...p };
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
    if (this.opts.markHz)  q.set('mark',  String(this.opts.markHz));
    if (this.opts.spaceHz) q.set('space', String(this.opts.spaceHz));
    if (this.opts.baud)    q.set('baud',  String(this.opts.baud));
    const qs = q.toString();
    const url = `${proto}//${location.host}/ws/decode/rtty${qs ? '?' + qs : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.opts.onStatus?.('listening…');
    ws.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : '';
      if (!text || text.startsWith('\x01')) return;
      for (const ch of text) this.opts.onChar?.(ch);
    };
    ws.onerror  = () => this.opts.onStatus?.('error');
    ws.onclose  = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
