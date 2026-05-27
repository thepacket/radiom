/** WebSocket client for the server-side direwolf-vendored HF AX.25 / APRS
 *  packet decoder. Streams 12 kHz int16 PCM up the WS; receives decoded
 *  frame text lines back down. */

export interface PacketDecoderOpts {
  sampleRate: number;
  /** 300 → HF AX.25 (10.147 MHz default), 1200 → VHF Bell-202 (144 MHz
   *  APRS default), 9600 → G3RUH (FOX cubesats / 70 cm UHF packet).
   *  Defaults to 300 to match the old behavior. */
  baud?: 300 | 1200 | 9600;
  /** Framing layer. 'il2p' enables Nino Carrillo's FEC framing
   *  (Reed-Solomon over the AX.25-shaped payload). Only meaningful
   *  at baud=1200 today — the IL2P config pins to VHF 1200. */
  framing?: 'ax25' | 'il2p';
  onLine?: (line: string) => void;
  onStatus?: (s: string) => void;
}

export class PacketDecoder {
  private ws: WebSocket | null = null;
  private opts: PacketDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: PacketDecoderOpts) {
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
    // Copy into a fresh ArrayBuffer in case the underlying is a
    // SharedArrayBuffer (AudioWorklet input) which WebSocket.send rejects.
    const buf = new ArrayBuffer(samples.byteLength);
    new Uint8Array(buf).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.ws!.send(buf);
  }
  private flushQueue() {
    while (this.queue.length) this.send(this.queue.shift()!);
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const baud = (this.opts.baud === 1200 || this.opts.baud === 9600)
                 ? this.opts.baud : 300;
    const framing = this.opts.framing === 'il2p' ? '&framing=il2p' : '';
    const url = `${proto}//${location.host}/ws/decode/packet?baud=${baud}${framing}`;
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
      this.opts.onLine?.(text);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
