/** WebSocket client for the server-side POCSAG decoder (multimon-ng).
 *
 *  Streams 12 kHz int16 PCM up, receives `{t:'page'}` JSON events with
 *  the decoded pager data (address + function + payload). Status
 *  messages flow as `{t:'status'}` frames. */

export interface PocsagPage {
  t: 'page';
  /** 512, 1200, or 2400 — POCSAG bit rate variant. */
  baud: number;
  /** RIC / address (decimal string, may be zero-padded). */
  address: string;
  /** 0..3 — pager function bits (kind of message). */
  fn: number;
  kind: 'alpha' | 'numeric' | 'tone';
  /** Decoded payload text (empty for tone-only pages). */
  payload: string;
  /** Raw multimon-ng line for debug. */
  raw: string;
  tsMs: number;
}

export interface PocsagDecoderOpts {
  sampleRate: number;
  dialKHz?: number;
  onPage?: (p: PocsagPage) => void;
  onStatus?: (s: string) => void;
}

export class PocsagDecoder {
  private ws: WebSocket | null = null;
  private opts: PocsagDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: PocsagDecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  feed(samples: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(new Int16Array(samples));
      if (this.queue.length > 25) this.queue.shift();
      return;
    }
    this.flushQueue();
    this.send(samples);
  }

  setDial(kHz: number) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'dial', kHz }));
    }
    this.opts.dialKHz = kHz;
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  private send(samples: Int16Array) {
    const buf = new ArrayBuffer(samples.byteLength);
    new Uint8Array(buf).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.ws!.send(buf);
  }
  private flushQueue() {
    while (this.queue.length) this.send(this.queue.shift()!);
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    if (this.opts.dialKHz) q.set('dial', String(this.opts.dialKHz));
    const url = `${proto}//${location.host}/ws/decode/pocsag${q.toString() ? '?' + q.toString() : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.opts.onStatus?.('listening (POCSAG 512/1200/2400)'); this.flushQueue(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: { t?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'page') this.opts.onPage?.(msg as PocsagPage);
      else if (msg.t === 'status' && typeof (msg as { msg?: unknown }).msg === 'string')
        this.opts.onStatus?.((msg as { msg: string }).msg);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
