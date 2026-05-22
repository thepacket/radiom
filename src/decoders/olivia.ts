/** Loader + thin TS wrapper around the Jalocha MFSK receiver compiled to
 *  WebAssembly. Decodes Olivia and (with appropriate parameters) Contestia.
 *
 *  Lifecycle:
 *    setMode(tones, bandwidth)   — (re)configure the receiver
 *    feed(samples, sampleRate)   — push int16 PCM
 *    getText() / clear()         — pull and reset accumulated decoded text
 */

export interface OliviaModule {
  HEAPF64: Float64Array;
  _malloc(n: number): number;
  _free(p: number): void;
  UTF8ToString(p: number): string;
  ccall(name: string, ret: string | null, args: string[], values: unknown[]): unknown;
}

let modulePromise: Promise<OliviaModule> | null = null;

async function loadModule(): Promise<OliviaModule> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const head = await fetch('/olivia-decoder.js', { method: 'HEAD' });
    if (!head.ok) throw new Error(`/olivia-decoder.js HTTP ${head.status} — run "npm run build:olivia"`);
    return new Promise<OliviaModule>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/olivia-decoder.js';
      script.onload = async () => {
        const factory = (globalThis as unknown as { createOliviaModule?: () => Promise<OliviaModule> }).createOliviaModule;
        if (!factory) { reject(new Error('createOliviaModule missing')); return; }
        try { resolve(await factory()); } catch (e) { reject(e); }
      };
      script.onerror = () => reject(new Error('failed to load /olivia-decoder.js'));
      document.head.appendChild(script);
    });
  })();
  return modulePromise;
}

export class OliviaDecoder {
  private mod: OliviaModule | null = null;
  private inputRate: number;
  private tones: number;
  private bandwidth: number;
  private carrierHz: number;
  private onChar: (ch: string) => void;
  private feedBufPtr = 0;
  private feedBufCap = 0;
  private lastTextLen = 0;
  private ready = false;

  constructor(opts: { sampleRate: number; tones?: number; bandwidth?: number; carrierHz?: number; onChar?: (ch: string) => void }) {
    this.inputRate = opts.sampleRate;
    this.tones = opts.tones ?? 32;
    this.bandwidth = opts.bandwidth ?? 1000;
    this.carrierHz = opts.carrierHz ?? 1500;
    this.onChar = opts.onChar ?? (() => {});
    this.init();
  }

  private async init() {
    this.mod = await loadModule();
    this.mod.ccall('olivia_init_at', null, ['number', 'number', 'number', 'number'],
                   [this.tones, this.bandwidth, this.inputRate, this.carrierHz]);
    this.ready = true;
  }

  setMode(tones: number, bandwidth: number) {
    this.tones = tones;
    this.bandwidth = bandwidth;
    if (this.mod && this.ready) {
      this.mod.ccall('olivia_init_at', null, ['number', 'number', 'number', 'number'],
                     [tones, bandwidth, this.inputRate, this.carrierHz]);
      this.lastTextLen = 0;
    }
  }

  setCarrierHz(hz: number) {
    this.carrierHz = hz;
    if (this.mod && this.ready) {
      this.mod.ccall('olivia_init_at', null, ['number', 'number', 'number', 'number'],
                     [this.tones, this.bandwidth, this.inputRate, hz]);
      this.lastTextLen = 0;
    }
  }

  feed(samples: Int16Array) {
    if (!this.mod || !this.ready) return;
    const n = samples.length;
    const bytes = n * 8; // double = 8 bytes
    if (this.feedBufCap < bytes) {
      if (this.feedBufPtr) this.mod._free(this.feedBufPtr);
      this.feedBufPtr = this.mod._malloc(bytes);
      this.feedBufCap = bytes;
    }
    // Convert int16 to float64 in-place into the WASM heap.
    const view = new Float64Array(this.mod.HEAPF64.buffer, this.feedBufPtr, n);
    for (let i = 0; i < n; i++) view[i] = samples[i] / 32768;
    this.mod.ccall('olivia_feed', null, ['number', 'number'], [this.feedBufPtr, n]);

    // Pull any new characters.
    const len = this.mod.ccall('olivia_text_length', 'number', [], []) as number;
    if (len > this.lastTextLen) {
      const ptr = this.mod.ccall('olivia_get_text', 'number', [], []) as number;
      const all = this.mod.UTF8ToString(ptr);
      const fresh = all.slice(this.lastTextLen);
      for (const ch of fresh) this.onChar(ch);
      this.lastTextLen = len;
    }
  }

  clear() {
    this.mod?.ccall('olivia_clear', null, [], []);
    this.lastTextLen = 0;
  }
}
