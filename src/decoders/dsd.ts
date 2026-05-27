// Copyright (c) Andre Paquette
//
// DSD (Digital Speech Decoder) client — talks to the server-side
// `dsd-fme` bridge over /ws/decode/dsd?mode=<mode>. Two-channel
// wire protocol:
//
//   ► outbound — binary frames: 12 kHz int16 LE PCM (source audio)
//   ◄ inbound text frames     :
//       { t:"event",  mode, raw, src, dst, ... }   structured metadata
//       { t:"text",   line:"..." }                 raw stderr line
//       { t:"status", msg:"..." }                  bridge status
//   ◄ inbound binary frames   : 8 kHz int16 LE PCM (decoded voice)
//
// Decoded voice is fed to a per-decoder GainNode that mounts straight
// to the player's AudioContext destination — same audio-output
// pattern memo'd in audio_out_streaming_pattern.md. Reconnect guard
// mirrors the LinuxALE decoder.

export type DsdMode =
  | 'dstar' | 'dmr' | 'dmrs' | 'nxdn48' | 'nxdn96'
  | 'ysf'   | 'dpmr' | 'm17'
  | 'p25p1' | 'p25p2';

export interface DsdEvent {
  mode: DsdMode;
  raw: string;
  tsMs: number;
  src?: string;
  dst?: string;
  nac?: string;
  cc?: string;
  ran?: string;
  slot?: number;
  sync?: string;
}

export interface DsdCallbacks {
  /** AudioContext from the player (used to play back decoded voice). */
  ctx: AudioContext;
  /** AudioNode the decoded voice should feed into. Pass `player.getMixer()`
   *  so VOL / COMP / EQ / PWR-mute all apply. Falls back to ctx.destination
   *  if omitted (legacy behaviour). */
  destination?: AudioNode;
  /** Output sample rate dsd-fme emits (8 kHz on every mode). */
  outputRate?: number;
  onText?: (line: string) => void;
  onEvent?: (ev: DsdEvent) => void;
  onStatus?: (msg: string) => void;
  onError?: (err: Error) => void;
}

export class DsdDecoder {
  private ws: WebSocket | null = null;
  private closed = false;
  private ctx: AudioContext;
  private outputRate: number;
  private out: GainNode;
  private nextStart = 0;
  private liveNodes: Set<AudioBufferSourceNode> = new Set();

  /** First-chunk WAV-header peeled state. dsd-fme's `-o -` mode on
   *  some forks emits a RIFF header before the raw PCM stream; we
   *  detect "RIFF" / "fmt " at the start and skip the 44-byte canonical
   *  header in that case so the first AudioBufferSource doesn't bark. */
  private gotFirstAudio = false;

  constructor(private mode: DsdMode, private cb: DsdCallbacks) {
    this.ctx = cb.ctx;
    this.outputRate = cb.outputRate ?? 8000;
    // Resume the context if the browser suspended it (every tab starts
    // suspended until a user gesture). Required for AudioBufferSource
    // playback to actually be audible.
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { /* user must click somewhere */ });
    }
    // Per-decoder gain node. Decoded digital voice tends to sit
    // ~6 dB quieter than analog speech once mbelib's IMBE/AMBE
    // decoder normalises, so apply a small boost.
    this.out = this.ctx.createGain();
    this.out.gain.value = 1.8;
    // Route through the player's mixer so VOL / COMP / EQ / PWR-mute
    // all apply. Caller passes player.getMixer(); if it's null we
    // fall back to ctx.destination (audio still plays, just bypassing
    // the volume knob).
    const dest = cb.destination ?? this.ctx.destination;
    this.out.connect(dest);
    this.open();
  }

  private open(): void {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${location.host}/ws/decode/dsd?mode=${encodeURIComponent(this.mode)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;     // guard against stale handlers post-reconnect
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.t === 'event') this.cb.onEvent?.(msg as DsdEvent);
          else if (msg.t === 'text') this.cb.onText?.(msg.line);
          else if (msg.t === 'status') this.cb.onStatus?.(msg.msg);
        } catch {}
        return;
      }
      // Binary frame = decoded 8 kHz int16 LE voice.
      let ab = e.data as ArrayBuffer;
      if (!ab || ab.byteLength < 2) return;
      // First chunk only: some dsd-fme forks emit a RIFF/WAV header
      // before raw PCM when `-o -` is used. Detect "RIFF" magic and
      // skip the standard 44-byte header so the first AudioBuffer
      // doesn't contain text bytes interpreted as samples.
      if (!this.gotFirstAudio) {
        this.gotFirstAudio = true;
        const u8 = new Uint8Array(ab);
        if (u8.length >= 12 &&
            u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 /* "RIFF" */) {
          ab = ab.slice(44);
          if (ab.byteLength < 2) return;
        }
      }
      // dsd-fme stdout chunks may arrive on odd byte counts; trim to
      // a whole-sample boundary before decoding into Int16Array.
      const evenLen = ab.byteLength & ~1;
      const i16 = new Int16Array(ab, 0, evenLen / 2);
      this.playDecodedFrame(i16);
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.cb.onError?.(new Error('dsd ws error'));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (!this.closed) {
        // Auto-reconnect once after a short delay. caller close()
        // suppresses the retry.
        setTimeout(() => { if (!this.closed) this.open(); }, 1500);
      }
    };
  }

  /** Schedule one frame of decoded voice for back-to-back playback.
   *  Same pattern as FreeDV / ISB demod: chain AudioBufferSourceNodes
   *  on `nextStart` so frames stitch seamlessly without manual mixing. */
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

  feed(samples: Int16Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || samples.length === 0) return;
    ws.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  /** Per-output gain knob (0..N). 1.0 = the default 1.8× boost in
   *  the constructor. Useful if the operator finds DSD voice too
   *  loud / quiet relative to analog sources. */
  setGain(g: number): void { this.out.gain.value = g; }

  close(): void {
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
}
