# FT8 / FT4 decoder

Vendored build of [kgoba/ft8_lib](https://github.com/kgoba/ft8_lib) compiled
to WebAssembly via Emscripten.

## Build

Requires Docker (the build runs inside the official `emscripten/emsdk` image
so you don't have to install the toolchain on your machine).

```sh
npm run build:ft8
```

That script:

1. Clones `ft8_lib` (default: `master`; pin a commit with `FT8_LIB_REV=...`).
2. Drops `wrapper.c` and `build_emcc.sh` into the source tree.
3. Runs `emcc` inside the Emscripten container.
4. Copies `ft8-decoder.js` and `ft8-decoder.wasm` into `public/` so Vite
   serves them.

The final assets are about 200–300 KB combined.

## Runtime use

```ts
import { decodeWindow } from '../decoders/ft8';
const messages = await decodeWindow(samples, sampleRate, 'FT8');
```

`samples` should be a 15 s window of mono Float32 PCM (`sampleRate >= 8000`,
12 kHz preferred). FT4 uses 7.5 s windows at the same sample rate.

## Wrapper API drift

`wrapper.c` calls a small subset of `ft8_lib`: `monitor_init`,
`monitor_process`, `ft8_find_sync`, `ft8_decode`, `message_decode`. The
upstream lib renames these occasionally. If the build fails with unresolved
references, check the upstream source in `decoders/ft8/.work/ft8_lib/` and
adjust `wrapper.c` accordingly.

## Why not server-side `jt9`?

That's still an option (gives FT8/FT4/JT65/JT9/WSPR/MSK144 in one shot).
This in-browser path was chosen for offline capability — once the .wasm is
cached, decoding works without a network round-trip to Fly.
