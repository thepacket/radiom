/** WebSocket client for the server-side fldigi-vendored Contestia decoder. */

export interface ContestiaFldigiOpts {
  sampleRate: number;
  tones: number;
  bandwidth: number;
  carrierHz: number;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class ContestiaFldigiDecoder {
  private ws: WebSocket | null = null;
  private opts: ContestiaFldigiOpts;
  private queue: Int16Array[] = [];

  constructor(opts: ContestiaFldigiOpts) {
    this.opts = opts;
    this.connect();
  }

  setMode(tones: number, bandwidth: number) { this.reconfigure({ tones, bandwidth }); }
  setCarrierHz(hz: number) { this.reconfigure({ carrierHz: hz }); }

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

  private reconfigure(p: Partial<ContestiaFldigiOpts>) {
    this.opts = { ...this.opts, ...p };
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connect();
  }

  private send(samples: Int16Array) {
    this.ws!.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    q.set('tones',     String(this.opts.tones));
    q.set('bandwidth', String(this.opts.bandwidth));
    q.set('carrier',   String(Math.round(this.opts.carrierHz)));
    const url = `${proto}//${location.host}/ws/decode/contestia-fldigi?${q.toString()}`;
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
