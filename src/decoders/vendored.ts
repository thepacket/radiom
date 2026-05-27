// Copyright (c) Andre Paquette
//
// Generic client for any "vendored binary, audio in, text out" decoder.
// Used for MSK144 / AIS / ACARS / TETRAPOL / OP25 / LRPT — they all
// share the same WS shape:
//
//   ► outbound binary: int16 LE PCM (12 kHz from the player)
//   ◄ inbound text   : JSON {t:"text"|"event"|"status"|"spot"|"image", ...}
//
// The endpoint differs per decoder (/ws/decode/msk144, /ws/decode/ais, …)
// — pass it in via `endpoint`.

export interface VendoredCallbacks {
  endpoint: string;            // e.g. '/ws/decode/ais'
  onText?:  (line: string) => void;
  onEvent?: (ev: Record<string, unknown>) => void;
  onSpot?:  (sp: Record<string, unknown>) => void;
  /** LRPT only. img.url is a blob URL the caller can drop into an
   *  <img src> — released automatically when the decoder is closed. */
  onImage?: (img: { name: string; mime: string; url: string; tsMs: number }) => void;
  onStatus?: (msg: string) => void;
  onError?: (err: Error) => void;
}

export class VendoredDecoder {
  private ws: WebSocket | null = null;
  private closed = false;
  /** When non-null, the next inbound binary frame is an LRPT image
   *  with this prelude's name+mime. Cleared after one binary frame. */
  private pendingImage: { name: string; mime: string } | null = null;
  /** Blob URLs we've handed out — revoked on close to avoid leaks. */
  private liveBlobs: Set<string> = new Set();
  constructor(private cb: VendoredCallbacks) {
    this.open();
  }

  private open(): void {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}${this.cb.endpoint}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          switch (msg.t) {
            case 'text':         this.cb.onText?.(msg.line); break;
            case 'event':        this.cb.onEvent?.(msg);  break;
            case 'spot':         this.cb.onSpot?.(msg);   break;
            case 'image-prelude':
              // Remember name/mime for the next binary frame.
              this.pendingImage = { name: msg.name, mime: msg.mime };
              break;
            case 'status':       this.cb.onStatus?.(msg.msg); break;
          }
        } catch {}
        return;
      }
      // Binary frame: only used by LRPT for image bytes, gated by a
      // preceding 'image-prelude' JSON. If we don't have a prelude
      // queued, the frame is unexpected — ignore.
      const ab = e.data as ArrayBuffer;
      if (!ab || !this.pendingImage) return;
      const blob = new Blob([ab], { type: this.pendingImage.mime });
      const url = URL.createObjectURL(blob);
      this.liveBlobs.add(url);
      this.cb.onImage?.({ ...this.pendingImage, url, tsMs: Date.now() });
      this.pendingImage = null;
    };
    ws.onerror = () => { if (this.ws === ws) this.cb.onError?.(new Error('ws error')); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (!this.closed) setTimeout(() => { if (!this.closed) this.open(); }, 1500);
    };
  }

  feed(samples: Int16Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || samples.length === 0) return;
    ws.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  /** Forward raw IQ baseband bytes verbatim (used by LRPT — satdump
   *  needs IQ, not audio). The player's `onIq` hook emits
   *  10-byte-GPS-header-prefixed BE-int16 stereo blocks; the bridge
   *  passes them straight through to satdump's stdin.
   *
   *  Future RTL-SDR backend will also surface its samples through
   *  `onIq`, so binding via `player.onIq = dec.feedIq` automatically
   *  works for the new source — no per-source branching needed. */
  feedIq(buf: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || buf.length === 0) return;
    ws.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }

  /** For MSK144: tell the bridge the current dial freq so spot
   *  annotations carry the right kHz. */
  sendDial(kHz: number): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ t: 'dial', kHz })); } catch {}
  }

  close(): void {
    this.closed = true;
    try { this.ws?.close(); } catch {}
    this.ws = null;
    // Free every blob URL we handed out. Caller's <img> tags will
    // break — but the panel is being torn down anyway.
    for (const url of this.liveBlobs) {
      try { URL.revokeObjectURL(url); } catch {}
    }
    this.liveBlobs.clear();
  }
}
