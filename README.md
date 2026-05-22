# radiom

A KiwiSDR-based web HF receiver with a large built-in decoder library
(CW, RTTY, FT8/FT4, WSPR, JT9/JT65, FST4, JS8, NAVTEX, WEFAX, HFDL, ALE 2G,
SSTV, FreeDV, Olivia, MFSK, MT63, Throb, and ~30 others).

The browser app connects to any [KiwiSDR](https://kiwisdr.com) server, streams
audio + waterfall, and routes the audio through a fleet of decoder bridges
running on a small Node backend.

## Screenshots

<p align="center">
  <img src="docs/screenshots/Screenshot_20260522_024236_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_024329_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_024409_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_024535_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_024641_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_024649_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_024732_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_024944_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_025021_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_025522_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_025547_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_025605_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_025849_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_030006_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_030103_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_030732_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_030738_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_030813_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_030834_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_030855_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_030905_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_030930_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_031023_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_031039_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_031225_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_031406_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_031501_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_031632_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_031640_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_031753_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_031909_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032039_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032052_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032106_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032146_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032219_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032251_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032400_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032417_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032549_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032559_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_032816_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_033138_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_033217_Chrome.jpg" width="32%"/>
  <img src="docs/screenshots/Screenshot_20260522_033602_Chrome.jpg" width="32%"/>
</p>

### Decoder library (~40 modes)

| Category               | Modes |
|------------------------|-------|
| Morse / RTTY           | CW, MCW, RTTY |
| MFSK / OFDM voice-band | MFSK, Olivia, Contestia (CTSA), MT63, DominoEX (DOMEX), THOR, Throb (THRB), FSQ, PI4 |
| PSK                    | PSK (PSK31 / variants) |
| WSJT-X family          | FT8, FT4, JT4, JT9, JT65, Q65, FST4, FST4W, WSPR, WSPR-15 (W15) |
| JS8                    | JS8 (via js8call binary) |
| Imaging                | WEFAX (FAX), SSTV, Hellschreiber (HELL) |
| Maritime / aero        | NAVTEX, SITOR-B, HFDL, SELCAL (SELC) |
| Aircraft + mil         | ALE 2G (LinuxALE), ARDOP |
| Voice                  | FreeDV (FDV) |
| Time / standards       | WWV |
| Visual / DSP-only      | iSB (independent-sideband demod), ECSS, QRSS |
| Detector-only          | STANAG 4285 (S4285), STANAG 4539 (S4539) — lock detection, not payload decoding |
| RSID                   | autonomous mode-ID decoder running alongside the heuristic AUTO classifier; auto-switches the active decoder when it identifies a transmission |
| HF packet              | AX.25 / APRS on 30 m (direwolf), 300-baud |

[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) lists the upstream
project each decoder is vendored from.

### UI

- 8-page touch-first keypad UI designed primarily for phone use.
- Compact mode + landscape support.
- AUTO/DARK/DARK+ palette modes, multiple waterfall colour LUTs.
- Memory / station / AI side panels.
- Server browser — fetches the live KiwiSDR public list via CORS proxies,
  shows users / SNR / antenna / location for each kiwi, supports favorites
  and custom entries.
- Persisted settings (localStorage) for every knob, mode, and panel state.

### Backend

- Single Node `server.mjs` serves the static front-end on port 8080 plus all
  `/ws/decode/*` decoder-bridge endpoints.
- KiwiSDR HTTP/WS pass-through proxy (`/api/kiwi-*`) for the v1.817+
  HTTPS-to-HTTP touch handshake.
- Optional bearer-token auth (`RADIOM_TOKEN`) + Origin allow-list on every
  WS endpoint.
- Per-IP and global concurrency limits for decoder WS connections.
- PWA-installable (offline-capable shell via VitePWA).
- fly.io deployable; standalone Dockerfile for self-hosters.

## Quick start

```bash
npm install
npm run dev      # HTTPS Vite dev server (uses mkcert) — for phone testing
npm run dev:http # plain HTTP on :5174 — for laptop / headless browsers
node server.mjs  # decoder backend on :8080 (Vite proxies /ws/decode/* here)
```

Decoder binaries are built per-decoder via `npm run build:<name>` (see
[package.json](package.json)). The full set is also assembled by the
multi-stage [Dockerfile](Dockerfile) used for the fly.io deployment.

## Project layout

```
src/             — TypeScript browser app (UI, audio graph, decoder clients)
public/          — static assets + AudioWorklet processors
decoder/         — Node-side decoder bridges (spawn binaries, forward over WS)
decoders/        — per-decoder build scripts and source glue
  decoders/<x>/build.sh   # clones upstream, builds binary into bin/
  decoders/<x>/main.cpp   # glue between fldigi/upstream API and our stdio protocol
server.mjs       — HTTP + WebSocket server, hosts /ws/decode/* endpoints
vite.config.ts   — dev-server config + /ws/decode proxy to server.mjs
Dockerfile       — multi-stage production build (Debian + Node 22)
```

## Deployment

The canonical deploy target is [fly.io](https://fly.io). [fly.toml](fly.toml)
is committed and assumes a shared-CPU VM with 512 MB RAM in region `yyz`
(Toronto) — fork and edit those values for your own app/region.

```bash
fly launch --no-deploy   # only the first time, to claim an app name
fly deploy               # build the multi-stage Docker image and ship it
```

For self-hosters who don't use fly, the [Dockerfile](Dockerfile) is
standalone:

```bash
docker build -t radiom .
docker run --rm -p 8080:8080 radiom
```

The image exposes port 8080 and runs `node server.mjs`, which serves both the
static front-end and the `/ws/decode/*` decoder bridges. All decoder binaries
are built inside the image, so the runtime container needs no compilers — just
a few shared libs (libasound2, libcodec2, libpng16-16, libsndfile1).

### Backend auth

All WebSocket endpoints (`/ws/*` — both `/ws/decode/*` decoder bridges and
the `/ws/<host>:<port>/...` Kiwi audio/waterfall proxy) accept an optional
shared bearer token plus an Origin allow-list, both controlled by env vars on
the server:

| Env var                       | Default | Effect                                               |
|-------------------------------|---------|------------------------------------------------------|
| `RADIOM_TOKEN`                | (empty) | Required token in `?token=…` query string on all `/ws/*` upgrades. Empty = open. |
| `RADIOM_ALLOWED_ORIGINS`      | (empty) | Comma-separated. Empty = any origin. Entries beginning with `.` match suffixes (e.g. `.fly.dev`). |
| `RADIOM_MAX_WS_PER_IP`        | `4`     | Max concurrent decoder WS per client IP.             |
| `RADIOM_MAX_WS_GLOBAL`        | `32`    | Max concurrent decoder WS across the whole server.   |

On fly.io, set the token via:

```bash
fly secrets set RADIOM_TOKEN=$(openssl rand -hex 24)
fly secrets set RADIOM_ALLOWED_ORIGINS=https://your-app.fly.dev
```

The browser-side token lives in `localStorage` under `radiom.token`. Users
either type it into **Settings → Backend Access → Server token**, or open a
share-link like `https://your-app.fly.dev/#token=…` and the token gets stored
+ stripped from the URL on first load.

## Contributing

radiom is a personal project that I'm opening up for others to learn from,
fork, and improve. Bug reports, patches, and new-decoder pull requests are
welcome — please open an issue first for anything larger than a small fix so
we can agree on scope. By submitting a contribution you agree to license it
under the same terms as the rest of the project (GPL-3.0-or-later).

## Authorship

Every line of application code in this repository was written by
[Claude Code](https://claude.com/claude-code) (Anthropic) under the direction
of Andre Paquette — design decisions, decoder selection, debugging strategy,
and on-air validation were human-driven; the actual TypeScript, C/C++ glue,
build scripts, and server code are the assistant's work.

Third-party decoder sources vendored under `decoders/<name>/` retain their
original authorship and licensing (see
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)).

## License

radiom is released under the **GNU General Public License v3.0 or later** —
see [LICENSE](LICENSE) for the full text and
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for the upstream projects
this repository builds against (fldigi, wsjt-x family, multimon-ng, direwolf,
dumphfdl, slowrxd, JS8Call, LinuxALE, …).

The project ships cherry-picked fldigi DSP/protocol source in-tree and links
against several GPL-2/GPL-3 decoder binaries at runtime, so the combined work
must be distributed under GPL-3.0-or-later.

Copyright © 2026 Andre Paquette and radiom contributors.

## OpenAI Whisper integration

The live-transcription feature uses OpenAI's Whisper API. Your API key is
entered through Settings (cog menu) and stored **only in browser localStorage**
on your device — it is never committed to source and never transmitted
anywhere except to `api.openai.com` over HTTPS when a transcription request
is made.
