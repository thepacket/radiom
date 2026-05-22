/** WebSocket client for the server-side FST4/FST4W decoder.
 *
 *  FST4W is the WSPR-style beacon submode of FST4. It runs in
 *  configurable periods (60 / 120 / 300 / 900 / 1800 sec) aligned to
 *  UTC. The client streams 12 kHz int16 PCM up the WS and consumes
 *  JSON spot/status messages. */

export interface Fst4Spot {
  t: 'spot';
  time: string;       // UTC HHMM
  snrDb: number;
  dtSec: number;
  freqHz: number;     // audio offset
  message: string;    // typically "CALL GRID PWR"
}

export interface Fst4DecoderOpts {
  sampleRate: number;
  dialKHz?: number;
  periodSec?: number;     // 60, 120, 300, 900, 1800
  onSpot?: (s: Fst4Spot) => void;
  onStatus?: (s: string) => void;
}

export class Fst4Decoder {
  private ws: WebSocket | null = null;
  private opts: Fst4DecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: Fst4DecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  feed(samples: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(new Int16Array(samples));
      // Cap pre-connect buffer so we don't hold a multi-MB tail.
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

  /** Tell the server to discard any in-progress capture and start a
   *  new period RIGHT NOW (skipping UTC alignment). */
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
    if (this.opts.dialKHz)   q.set('dial',   String(this.opts.dialKHz));
    if (this.opts.periodSec) q.set('period', String(this.opts.periodSec));
    const url = `${proto}//${location.host}/ws/decode/fst4${q.toString() ? '?' + q.toString() : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.opts.onStatus?.(`listening (${this.opts.periodSec ?? 120}-s slots)`);
      this.flushQueue();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: { t?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'spot') this.opts.onSpot?.(msg as Fst4Spot);
      else if (msg.t === 'status' && typeof (msg as { msg?: unknown }).msg === 'string')
        this.opts.onStatus?.((msg as { msg: string }).msg);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
