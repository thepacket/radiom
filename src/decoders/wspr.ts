/** WebSocket client for the server-side WSPR decoder.
 *
 *  WSPR runs in 2-minute periods aligned to UTC even minutes. The server
 *  handles the buffering + wsprd spawn; the client just streams 12 kHz
 *  int16 PCM up the WS and consumes JSON spot/status messages back. */

export interface WsprSpot {
  t: 'spot';
  time: string;       // UTC HHMM
  snrDb: number;
  dtSec: number;
  freqMHz: number;
  driftHz: number;
  message: string;    // typically "CALL GRID PWR"
}

export interface WsprDecoderOpts {
  sampleRate: number;
  dialKHz?: number;
  onSpot?: (s: WsprSpot) => void;
  onStatus?: (s: string) => void;
}

export class WsprDecoder {
  private ws: WebSocket | null = null;
  private opts: WsprDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: WsprDecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  feed(samples: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(new Int16Array(samples));
      // WSPR's working set is 24 MB / 2 min — drop older queued audio if
      // the WS hasn't opened yet, otherwise we'd hold a multi-MB tail.
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

  /** Tell the server-side decoder to discard any in-progress capture
   *  and start a new period RIGHT NOW (skipping UTC alignment). Used
   *  by the INJECT test path so a pre-aligned WAV sample fills the
   *  full 116-sec capture window starting at playback time. */
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
    const url = `${proto}//${location.host}/ws/decode/wspr${q.toString() ? '?' + q.toString() : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.opts.onStatus?.('listening (2-min periods)'); this.flushQueue(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: { t?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'spot') this.opts.onSpot?.(msg as WsprSpot);
      else if (msg.t === 'status' && typeof (msg as { msg?: unknown }).msg === 'string')
        this.opts.onStatus?.((msg as { msg: string }).msg);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
