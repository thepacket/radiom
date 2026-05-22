/** WebSocket client for the server-side fldigi-vendored MFSK decoder. */

export type MfskMode = 'mfsk4' | 'mfsk8' | 'mfsk11' | 'mfsk16' | 'mfsk22' | 'mfsk31' | 'mfsk32' | 'mfsk64' | 'mfsk128';

export interface MfskFldigiOpts {
  sampleRate: number;
  mode: MfskMode;
  pitchHz: number;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class MfskFldigiDecoder {
  private ws: WebSocket | null = null;
  private opts: MfskFldigiOpts;
  private queue: Int16Array[] = [];

  constructor(opts: MfskFldigiOpts) {
    this.opts = opts;
    this.connect();
  }

  setMode(mode: MfskMode) {
    this.opts = { ...this.opts, mode };
    try { this.ws?.close(); } catch {}
    this.ws = null;
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
  clear() {}

  private send(samples: Int16Array) {
    this.ws!.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    q.set('mode',  this.opts.mode);
    q.set('pitch', String(Math.round(this.opts.pitchHz)));
    const url = `${proto}//${location.host}/ws/decode/mfsk-fldigi?${q.toString()}`;
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
