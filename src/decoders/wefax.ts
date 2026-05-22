/** WebSocket client for the server-side WEFAX decoder.
 *  Same shape as PSK/CW/RTTY so shell wiring is uniform.
 *
 *  Stage-1 scaffold: the server emits a synthetic gradient image so the UI
 *  panel (canvas + status line) can be wired and watched end-to-end. The wire
 *  protocol matches the real decoder that lands later. */

export interface WefaxImageMeta {
  width: number;   // pixels per row (typically 1809 = IOC 576)
  lpm?: number;
  ioc?: number;
}

export interface WefaxRow {
  seq: number;
  /** `meta.width` grayscale bytes, 0 = black, 255 = white. */
  data: Uint8Array;
}

export interface WefaxAlign {
  originPx: number;
  driftPxPerRow: number;
  oldSpp: number;
  newSpp: number;
}

export interface WefaxDecoderOpts {
  onStatus?: (s: string) => void;
  onImageStart?: (meta: WefaxImageMeta) => void;
  onRow?: (row: WefaxRow) => void;
  onImageEnd?: (info: { height: number }) => void;
  onAlign?: (info: WefaxAlign) => void;
}

export class WefaxDecoder {
  private ws: WebSocket | null = null;
  private opts: WefaxDecoderOpts;
  private queue: Int16Array[] = [];

  constructor(opts: WefaxDecoderOpts) {
    this.opts = opts;
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

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  private send(samples: Int16Array) {
    this.ws!.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/decode/wefax`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.opts.onStatus?.('listening…');
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let ev: { t?: string; [k: string]: unknown };
      try { ev = JSON.parse(e.data); } catch { return; }
      switch (ev.t) {
        case 'status':
          this.opts.onStatus?.(String(ev.msg ?? ''));
          break;
        case 'image-start':
          this.opts.onImageStart?.({
            width: Number(ev.width) || 1809,
            lpm: Number(ev.lpm) || undefined,
            ioc: Number(ev.ioc) || undefined,
          });
          break;
        case 'row': {
          const data = base64ToBytes(String(ev.data ?? ''));
          this.opts.onRow?.({ seq: Number(ev.seq) | 0, data });
          break;
        }
        case 'image-end':
          this.opts.onImageEnd?.({ height: Number(ev.height) || 0 });
          break;
        case 'align':
          this.opts.onAlign?.({
            originPx:      Number(ev.originPx) || 0,
            driftPxPerRow: Number(ev.driftPxPerRow) || 0,
            oldSpp:        Number(ev.oldSpp) || 0,
            newSpp:        Number(ev.newSpp) || 0,
          });
          break;
      }
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
