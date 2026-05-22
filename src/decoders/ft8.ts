/** Loader + thin TS wrapper around the Emscripten-compiled ft8_lib.
 *  See decoders/ft8/build.sh for how the .wasm is produced. */

export interface Ft8Message {
  text: string;
  freqHz: number;
  dtSec: number;
  snrDb: number;
}

interface Ft8Module {
  HEAPF32: Float32Array;
  _malloc(n: number): number;
  _free(p: number): void;
  UTF8ToString(p: number): string;
  ccall(name: string, ret: string | null, args: string[], values: unknown[]): unknown;
}

let modulePromise: Promise<Ft8Module> | null = null;

async function loadModule(): Promise<Ft8Module> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    // HEAD-check first so we don't get fooled by a SPA fallback returning HTML.
    const head = await fetch('/ft8-decoder.js', { method: 'HEAD' });
    if (!head.ok) throw new Error(`/ft8-decoder.js HTTP ${head.status} — run "npm run build:ft8"`);
    const ct = head.headers.get('content-type') || '';
    if (!ct.includes('javascript') && !ct.includes('ecmascript')) {
      // Vite dev server may serve text/html for missing files (SPA fallback).
      // Read a few bytes to confirm.
      const probe = await fetch('/ft8-decoder.js');
      const text = (await probe.text()).slice(0, 200);
      if (text.trimStart().startsWith('<')) {
        throw new Error('/ft8-decoder.js missing — server returned HTML. Run "npm run build:ft8"');
      }
    }
    return new Promise<Ft8Module>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/ft8-decoder.js';
      script.onload = async () => {
        const factory = (globalThis as unknown as { createFt8Module?: () => Promise<Ft8Module> }).createFt8Module;
        if (!factory) { reject(new Error('createFt8Module missing — Emscripten output may be malformed')); return; }
        try { resolve(await factory()); } catch (e) { reject(e); }
      };
      script.onerror = () => reject(new Error('failed to load /ft8-decoder.js'));
      document.head.appendChild(script);
    });
  })();
  return modulePromise;
}

/** Decode one FT8 (15 s) or FT4 (7.5 s) audio window. Sample rate must be ≥ 8000. */
export async function decodeWindow(
  samples: Float32Array,
  sampleRate: number,
  mode: 'FT8' | 'FT4' = 'FT8',
): Promise<Ft8Message[]> {
  const M = await loadModule();
  // Copy samples into the WASM heap.
  const bytes = samples.length * 4;
  const ptr = M._malloc(bytes);
  try {
    new Float32Array(M.HEAPF32.buffer, ptr, samples.length).set(samples);
    M.ccall('ft8_decode_window', 'number',
      ['number', 'number', 'number', 'number'],
      [ptr, samples.length, sampleRate, mode === 'FT4' ? 1 : 0]);

    const count = M.ccall('ft8_message_count', 'number', [], []) as number;
    const out: Ft8Message[] = [];
    for (let i = 0; i < count; i++) {
      const textPtr = M.ccall('ft8_message_text', 'number', ['number'], [i]) as number;
      out.push({
        text:   M.UTF8ToString(textPtr),
        freqHz: M.ccall('ft8_message_freq', 'number', ['number'], [i]) as number,
        dtSec:  M.ccall('ft8_message_dt',   'number', ['number'], [i]) as number,
        snrDb:  M.ccall('ft8_message_snr',  'number', ['number'], [i]) as number,
      });
    }
    M.ccall('ft8_clear', null, [], []);
    return out;
  } finally {
    M._free(ptr);
  }
}
