/** WebSocket client for the server-side analog SSTV decoder.
 *
 *  Streaming PCM up, JSON status messages + base64 PNG data URLs back.
 *  Each completed SSTV transmission (Robot/Scottie/Martin/PD/etc) is
 *  delivered as a single `{t:'image'}` message with a `data:image/png`
 *  URL the panel can drop straight into an <img>. */

export interface SstvImage {
  t: 'image';
  mode: string;
  dataUrl: string;
  tsMs: number;
}

export interface SstvDecoderOpts {
  sampleRate: number;
  dialKHz?: number;
  onImage?: (img: SstvImage) => void;
  onStatus?: (s: string) => void;
}

export class SstvDecoder {
  private ws: WebSocket | null = null;
  private opts: SstvDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: SstvDecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  feed(samples: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(new Int16Array(samples));
      // SSTV transmissions are 30 s - 4 min long; we don't want to
      // sit on the entire pre-open buffer. Cap at ~5 s.
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
    const url = `${proto}//${location.host}/ws/decode/sstv${q.toString() ? '?' + q.toString() : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.opts.onStatus?.('listening (waiting for VIS code…)'); this.flushQueue(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: { t?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'image') this.opts.onImage?.(msg as SstvImage);
      else if (msg.t === 'status' && typeof (msg as { msg?: unknown }).msg === 'string')
        this.opts.onStatus?.((msg as { msg: string }).msg);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
