// Copyright (c) Andre Paquette
//
// Generic multimon-ng client — wraps /ws/decode/multimon?mode=<mode>.
// Used for FLEX / DTMF / ZVEI / AFSK1200 / X10 / EAS — the remaining
// modes in the already-vendored multimon-ng binary beyond SELCAL and
// POCSAG (which have their own dedicated decoders). DSC routes here
// too but uses its own /ws/decode/dsc endpoint (jbirby/DSC-Codec)
// because multimon-ng has no DSC demod.
//
// ERMES retired: multimon-ng has no ERMES demod and the protocol is
// decommissioned across Europe since ~2010.

export type MultimonMode =
  | 'flex' | 'flex_next' | 'ufsk1200' | 'clipfsk' | 'fmsfsk' | 'dtmf' | 'zvei'
  | 'afsk1200' | 'afsk2400' | 'hapn4800' | 'fsk9600'
  | 'dpzvei' | 'morse'
  | 'x10' | 'eas' | 'dsc'
  | 'ccir' | 'ccitt' | 'eea' | 'eia' | 'euro';

export interface MultimonEvent {
  mode: MultimonMode;
  raw: string;
  tsMs: number;
  // Field set varies per mode — only what the bridge could extract.
  fmt?: string;
  ric?: string;
  kind?: string;
  payload?: string;
  digits?: string;
  code?: string;
}

export interface MultimonCallbacks {
  onText?: (line: string) => void;
  onEvent?: (ev: MultimonEvent) => void;
  onStatus?: (msg: string) => void;
  onError?: (err: Error) => void;
}

export class MultimonDecoder {
  private ws: WebSocket | null = null;
  private closed = false;
  constructor(private mode: MultimonMode, private cb: MultimonCallbacks) {
    this.open();
  }

  private open(): void {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // DSC isn't a multimon-ng mode (multimon-ng has no DSC demod).
    // The server routes DSC through jbirby/DSC-Codec at its own
    // endpoint; everything else (FLEX, EAS, ZVEI…) still hits the
    // generic multimon-ng bridge.
    const url = this.mode === 'dsc'
      ? `${scheme}//${location.host}/ws/decode/dsc`
      : `${scheme}//${location.host}/ws/decode/multimon?mode=${encodeURIComponent(this.mode)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      if (typeof e.data !== 'string') return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.t === 'event') this.cb.onEvent?.(msg as MultimonEvent);
        else if (msg.t === 'text') this.cb.onText?.(msg.line);
        else if (msg.t === 'status') this.cb.onStatus?.(msg.msg);
      } catch {}
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.cb.onError?.(new Error('multimon ws error'));
    };
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

  close(): void {
    this.closed = true;
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}
