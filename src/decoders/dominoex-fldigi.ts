/** WebSocket client for the server-side fldigi-vendored DominoEX decoder. */

export type DominoexMode = 'dominoex4' | 'dominoex5' | 'dominoex8' | 'dominoex11' | 'dominoex16' | 'dominoex22' | 'dominoex44' | 'dominoex88';

export interface DominoexFldigiOpts {
  sampleRate: number;
  mode: DominoexMode;
  carrierHz: number;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class DominoexFldigiDecoder {
  private ws: WebSocket | null = null;
  private opts: DominoexFldigiOpts;
  private queue: Int16Array[] = [];

  constructor(opts: DominoexFldigiOpts) {
    this.opts = opts;
    this.connect();
  }

  setMode(mode: DominoexMode) {
    this.opts = { ...this.opts, mode };
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connect();
  }
  setCarrierHz(hz: number) {
    this.opts = { ...this.opts, carrierHz: hz };
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
    q.set('mode',    this.opts.mode);
    q.set('carrier', String(Math.round(this.opts.carrierHz)));
    const url = `${proto}//${location.host}/ws/decode/dominoex-fldigi?${q.toString()}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { if (this.ws === ws) this.opts.onStatus?.('listening…'); };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const text = typeof e.data === 'string' ? e.data : '';
      if (!text) return;
      for (const ch of text) this.opts.onChar?.(ch);
    };
    ws.onerror  = () => { if (this.ws === ws) this.opts.onStatus?.('error'); };
    ws.onclose  = () => {
      // Only act on close events for the *current* ws. setMode / setCarrierHz
      // intentionally close the old ws while assigning a new one; without
      // this guard the old close handler would null out the new ws.
      if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; }
    };
  }
}
