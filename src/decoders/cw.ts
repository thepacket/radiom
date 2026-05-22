/** WebSocket-backed CW decoder.
 *
 *  Streams 12 kHz int16 mono PCM to the server-side decoder at
 *  `/ws/decode/cw` and emits decoded characters back via the `onChar`
 *  callback. The server also occasionally sends `\x01PITCH:<hz>` control
 *  messages (when its pitch tracker locks on a new tone); those are
 *  surfaced via `onStatus` for the UI.
 */

export interface CWDecoderOpts {
  sampleRate: number;
  pitchHz?: number;
  wpm?: number;
  lowerLimit?: number;
  upperLimit?: number;
  range?: number;
  bandwidth?: number;
  matchedFilter?: boolean;
  attack?: number;          // 0..2
  decay?: number;           // 0..2
  lowercase?: boolean;
  dashDot?: number;
  useSOM?: boolean;
  onChar?: (ch: string) => void;
  onStatus?: (s: string) => void;
}

export class CWDecoder {
  private ws: WebSocket | null = null;
  private opts: CWDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: CWDecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  setPitch(_hz: number) { /* server-side decoder owns its own pitch */ }

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
    this.ws!.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  private flushQueue() {
    while (this.queue.length) this.send(this.queue.shift()!);
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    if (this.opts.pitchHz)      q.set('pitch',  String(Math.round(this.opts.pitchHz)));
    if (this.opts.wpm)          q.set('wpm',    String(Math.round(this.opts.wpm)));
    if (this.opts.lowerLimit)   q.set('lower',  String(Math.round(this.opts.lowerLimit)));
    if (this.opts.upperLimit)   q.set('upper',  String(Math.round(this.opts.upperLimit)));
    if (this.opts.range != null)q.set('range',  String(Math.round(this.opts.range)));
    if (this.opts.bandwidth)    q.set('bw',     String(Math.round(this.opts.bandwidth)));
    if (this.opts.matchedFilter != null) q.set('mfilt',     this.opts.matchedFilter ? '1' : '0');
    if (this.opts.attack != null)        q.set('attack',    String(this.opts.attack));
    if (this.opts.decay  != null)        q.set('decay',     String(this.opts.decay));
    if (this.opts.lowercase != null)     q.set('lowercase', this.opts.lowercase ? '1' : '0');
    if (this.opts.dashDot)               q.set('dashdot',   String(this.opts.dashDot));
    if (this.opts.useSOM != null)        q.set('som',       this.opts.useSOM ? '1' : '0');
    const qs  = q.toString();
    const url = `${proto}//${location.host}/ws/decode/cw${qs ? '?' + qs : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.opts.onStatus?.('listening…'); this.flushQueue(); };
    ws.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : '';
      if (!text || text.startsWith('\x01')) return;
      // Plain decoded characters: forward one at a time so the UI can append.
      for (const ch of text) this.opts.onChar?.(ch);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
