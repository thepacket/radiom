/** WebSocket client for the server-side PSK31 decoder.
 *  Same shape as CW/RTTY so shell wiring is uniform. */

export interface PSKDecoderOpts {
  sampleRate: number;
  /** Audio frequency of the PSK carrier (Hz). Default 1000. */
  pitchHz?: number;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class PSKDecoder {
  private ws: WebSocket | null = null;
  private opts: PSKDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: PSKDecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  setPitch(hz: number) {
    this.opts = { ...this.opts, pitchHz: hz };
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
    if (this.opts.pitchHz) q.set('pitch', String(this.opts.pitchHz));
    const qs = q.toString();
    const url = `${proto}//${location.host}/ws/decode/psk${qs ? '?' + qs : ''}`;
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
