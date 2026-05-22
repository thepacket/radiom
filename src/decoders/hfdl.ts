/** WebSocket client for the server-side dumphfdl HFDL decoder.
 *
 *  Streams raw IQ bytes (int16 BE, interleaved I/Q — KiwiSDR stereo
 *  wire format) up the WS. The server bridge byte-swaps and pipes to
 *  the dumphfdl binary, which emits one JSON object per decoded HFDL
 *  message. We forward those JSON lines to onMessage, leaving parsing
 *  to the UI layer (so logs can pretty-print as the protocol evolves
 *  without bridge changes). */

export interface HFDLDecoderOpts {
  /** HFDL channel centre frequency, in kHz. */
  freqKHz: number;
  /** Centre of the IQ stream — typically the same as freqKHz. */
  centerKHz?: number;
  onMessage?: (json: unknown) => void;
  onStatus?:  (s: string) => void;
}

export class HFDLDecoder {
  private ws: WebSocket | null = null;
  private opts: HFDLDecoderOpts;
  private buf = '';

  constructor(opts: HFDLDecoderOpts) {
    this.opts = opts;
    this.connect();
  }

  /**
   * Feed raw KiwiSDR IQ payload bytes (interleaved I16 BE I/Q, GPS
   * header already stripped by the player). Only sends when WS is open;
   * IQ frames at 12 kHz × 4 bytes/sample produce ~48 KiB/s, so we don't
   * bother queuing.
   */
  feed(iqBytes: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(iqBytes.buffer.slice(iqBytes.byteOffset, iqBytes.byteOffset + iqBytes.byteLength));
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    q.set('freq', String(Math.round(this.opts.freqKHz)));
    if (Number.isFinite(this.opts.centerKHz)) q.set('center', String(Math.round(this.opts.centerKHz!)));
    const url = `${proto}//${location.host}/ws/decode/hfdl?${q.toString()}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.opts.onStatus?.('listening…'); };
    ws.onmessage = (e) => {
      const text = typeof e.data === 'string' ? e.data : '';
      if (!text) return;
      this.buf += text;
      let nl;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).replace(/\r$/, '');
        this.buf = this.buf.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          const obj = JSON.parse(line);
          this.opts.onMessage?.(obj);
        } catch {
          // dumphfdl banner / non-JSON status — ignore.
        }
      }
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}
