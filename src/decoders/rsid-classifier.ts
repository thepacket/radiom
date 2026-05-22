/** WebSocket client for the server-side RSID auto-classifier.
 *
 *  Streams 12 kHz int16 PCM to /ws/decode/rsid; receives NDJSON detection
 *  events `{ t: 'detect', mode, id, freq }` from fldigi's RSID decoder.
 *
 *  This is an *autonomous* classifier — it doesn't need a confidence
 *  threshold or a settling window. RSID is a Reed-Solomon coded burst, so
 *  a successful decode is essentially error-free; every event is a real
 *  detection.
 */

export interface RsidDetection {
  mode: string;        // canonical fldigi sname, e.g. "OLIVIA-8/500"
  id: number;          // fldigi MODE_* enum value
  freq: number;        // detected RSID centre offset (Hz)
}

export interface RsidClassifierOpts {
  sampleRate: number;  // input PCM rate (binary expects 12 kHz)
  onDetect: (d: RsidDetection) => void;
  onStatus?: (s: string) => void;
}

export class RsidClassifier {
  private ws: WebSocket | null = null;
  private opts: RsidClassifierOpts;
  private outQueue: ArrayBuffer[] = [];

  constructor(opts: RsidClassifierOpts) {
    this.opts = opts;
    this.connect();
  }

  feed(samples: Int16Array) {
    // Copy into a fresh ArrayBuffer — the underlying may be a
    // SharedArrayBuffer (AudioWorklet input) which WebSocket.send rejects.
    const buf = new ArrayBuffer(samples.byteLength);
    new Uint8Array(buf).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
    } else {
      // Buffer up to ~1 s of audio while the WS is still opening.
      if (this.outQueue.length < 50) this.outQueue.push(buf);
    }
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url   = `${proto}//${location.host}/ws/decode/rsid`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.opts.onStatus?.('RSID classifier connected');
      while (this.outQueue.length) ws.send(this.outQueue.shift()!);
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: { t?: string; mode?: string; id?: number; freq?: number };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'detect') {
        this.opts.onDetect({
          mode: String(msg.mode ?? '?'),
          id:   msg.id  ?? -1,
          freq: msg.freq ?? 0,
        });
      }
    });
    ws.addEventListener('close', () => {
      this.opts.onStatus?.('RSID classifier disconnected');
      this.ws = null;
    });
    ws.addEventListener('error', () => {
      this.opts.onStatus?.('RSID classifier error');
    });
  }
}
