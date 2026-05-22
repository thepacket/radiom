/** WebSocket client for the server-side JT9 decoder.
 *
 *  JT9 runs in 1-minute slots aligned to UTC minute boundaries. Same
 *  wire protocol as the other batch decoders (WSPR / FST4 / JS8): client
 *  streams 12 kHz int16 PCM up to `/ws/decode/jt9`, server batches a
 *  minute of audio and shells out to `jt9 -9 <wav>`. */

export interface Jt9Spot {
  t: 'spot';
  time: string;       // UTC HHMM
  snrDb: number;
  dtSec: number;
  freqHz: number;     // audio-band offset
  message: string;    // typically "CQ N0CALL EM48" or contest exchange
}

export interface Jt9DecoderOpts {
  sampleRate: number;
  dialKHz?: number;
  onSpot?: (s: Jt9Spot) => void;
  onStatus?: (s: string) => void;
}

export class Jt9Decoder {
  private ws: WebSocket | null = null;
  private opts: Jt9DecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: Jt9DecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  feed(samples: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(new Int16Array(samples));
      if (this.queue.length > 50) this.queue.shift();
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

  triggerNow() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'trigger' }));
    }
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
    const url = `${proto}//${location.host}/ws/decode/jt9${q.toString() ? '?' + q.toString() : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.opts.onStatus?.('listening (1-min slots)'); this.flushQueue(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: { t?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'spot') this.opts.onSpot?.(msg as Jt9Spot);
      else if (msg.t === 'status' && typeof (msg as { msg?: unknown }).msg === 'string')
        this.opts.onStatus?.((msg as { msg: string }).msg);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
