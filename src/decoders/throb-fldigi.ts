/** WebSocket client for the server-side fldigi-vendored Throb decoder. */

export type ThrobMode = 'throb1' | 'throb2' | 'throb4' | 'throbx1' | 'throbx2' | 'throbx4';

export interface ThrobFldigiOpts {
  sampleRate: number;
  mode: ThrobMode;
  pitchHz: number;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class ThrobFldigiDecoder {
  private ws: WebSocket | null = null;
  private opts: ThrobFldigiOpts;
  private queue: Int16Array[] = [];

  constructor(opts: ThrobFldigiOpts) {
    this.opts = opts;
    this.connect();
  }

  setMode(mode: ThrobMode) {
    this.opts = { ...this.opts, mode };
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
    q.set('mode',  this.opts.mode);
    q.set('pitch', String(Math.round(this.opts.pitchHz)));
    const url = `${proto}//${location.host}/ws/decode/throb-fldigi?${q.toString()}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.opts.onStatus?.(`listening (${this.opts.mode})`);
    ws.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : '';
      if (!text) return;
      if (text.startsWith('{')) {
        try {
          const msg = JSON.parse(text) as { t?: string; msg?: string };
          if (msg.t === 'status' && typeof msg.msg === 'string') this.opts.onStatus?.(msg.msg);
        } catch {}
        return;
      }
      for (const ch of text) this.opts.onChar?.(ch);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
