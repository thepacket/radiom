/** WebSocket client for the server-side FreeDV decoder.
 *
 *  Two-channel wire protocol: binary frames are decoded 8 kHz int16
 *  speech (we play them through Web Audio); text frames are JSON
 *  status messages. The client owns its own audio output node so the
 *  decoded voice plays alongside / independently of the main Kiwi
 *  audio path. */

export type FreedvMode = '1600' | '700C' | '700D' | '700E' | '2020' | '2020B';

export interface FreedvDecoderOpts {
  /** AudioContext from the player — we mount our own GainNode → destination. */
  ctx: AudioContext;
  /** Output sample rate of freedv_rx (8 kHz for all current modes). */
  outputRate?: number;
  mode?: FreedvMode;
  dialKHz?: number;
  onStatus?: (s: string) => void;
}

export class FreedvDecoder {
  private ws: WebSocket | null = null;
  private opts: FreedvDecoderOpts;
  private queue: Int16Array[] = [];
  private ctx: AudioContext;
  private outputRate: number;
  private out: GainNode;
  private nextStart = 0;
  private liveNodes: Set<AudioBufferSourceNode> = new Set();
  private closed = false;

  constructor(opts: FreedvDecoderOpts) {
    this.opts = opts;
    this.ctx = opts.ctx;
    this.outputRate = opts.outputRate ?? 8000;
    this.out = this.ctx.createGain();
    this.out.gain.value = 1.4;     // FreeDV decoded speech tends to be quieter than analog SSB.
    this.out.connect(this.ctx.destination);
    this.connect();
  }

  /** Pipe Kiwi 12 kHz int16 PCM up to the bridge. The server-side
   *  decimator handles the 12k→8k conversion before feeding freedv_rx. */
  feed(samples: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(new Int16Array(samples));
      if (this.queue.length > 25) this.queue.shift();
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

  setMode(mode: FreedvMode) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'mode', mode }));
    }
    this.opts.mode = mode;
  }

  close() {
    this.closed = true;
    for (const n of this.liveNodes) {
      try { n.stop(); } catch {}
      try { n.disconnect(); } catch {}
    }
    this.liveNodes.clear();
    try { this.out.disconnect(); } catch {}
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
    if (this.opts.mode)    q.set('mode', this.opts.mode);
    const url = `${proto}//${location.host}/ws/decode/freedv${q.toString() ? '?' + q.toString() : ''}`;
    this.opts.onStatus?.('connecting…');
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch (e) { this.opts.onStatus?.('error: ' + (e as Error).message); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.opts.onStatus?.(`listening · mode ${this.opts.mode ?? '700D'}`); this.flushQueue(); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let msg: { t?: string };
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.t === 'status' && typeof (msg as { msg?: unknown }).msg === 'string')
          this.opts.onStatus?.((msg as { msg: string }).msg);
        return;
      }
      // Binary frame — decoded speech. Pull as int16 LE.
      const ab = e.data as ArrayBuffer;
      if (!ab || ab.byteLength < 2) return;
      const i16 = new Int16Array(ab);
      this.playDecodedFrame(i16);
    };
    ws.onerror = () => this.opts.onStatus?.('error');
    ws.onclose = () => { if (this.ws === ws) { this.opts.onStatus?.('closed'); this.ws = null; } };
  }

  /** Schedule one frame of decoded speech for back-to-back playback.
   *  Same pattern as the ISB demod's output: AudioBufferSourceNodes
   *  chained on nextStart so frames stitch seamlessly. */
  private playDecodedFrame(i16: Int16Array): void {
    if (this.closed) return;
    const ctx = this.ctx;
    const n = i16.length;
    if (n === 0) return;
    const buf = ctx.createBuffer(1, n, this.outputRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = i16[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const now = ctx.currentTime;
    if (this.nextStart < now + 0.02) this.nextStart = now + 0.08;
    src.start(this.nextStart);
    this.nextStart += n / this.outputRate;
    this.liveNodes.add(src);
    src.onended = () => { this.liveNodes.delete(src); };
  }
}
