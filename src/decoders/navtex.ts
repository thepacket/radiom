/** WebSocket client for the server-side NAVTEX / SITOR-B decoder.
 *  Same shape as the CW client: streams 12 kHz int16 PCM up the WS,
 *  receives decoded characters down. */

export interface NAVTEXDecoderOpts {
  sampleRate: number;
  /** 'navtex' (default, full SITOR-B with NAVTEX message framing) or
   *  'sitorb' (SITOR-B FEC mode without the NAVTEX-specific framing). */
  mode?: 'navtex' | 'sitorb';
  carrierHz?: number;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class NAVTEXDecoder {
  private ws: WebSocket | null = null;
  private opts: NAVTEXDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: NAVTEXDecoderOpts) {
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
    const q = new URLSearchParams();
    if (this.opts.mode) q.set('mode', this.opts.mode);
    if (this.opts.carrierHz) q.set('carrier', String(Math.round(this.opts.carrierHz)));
    const qs = q.toString();
    const url = `${proto}//${location.host}/ws/decode/navtex${qs ? '?' + qs : ''}`;
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
      for (const ch of text) this.opts.onChar?.(ch);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
