# radiom

A KiwiSDR-based web HF receiver with a large built-in decoder library
(CW, RTTY, FT8/FT4, WSPR, JT9/JT65, FST4, JS8, NAVTEX, WEFAX, HFDL, ALE 2G,
SSTV, FreeDV, Olivia, MFSK, MT63, Throb, and ~30 others).

The browser app connects to any [KiwiSDR](https://kiwisdr.com) server, streams
audio + waterfall, and routes the audio through a fleet of decoder bridges
running on a small Node backend.

## Screenshots

![radiom — waterfall, FFT, and an active decoder panel](docs/screenshots/hero.png)

<p align="center">
  <img src="docs/screenshots/decoders.png" alt="Decoder variety — WEFAX, SSTV, HFDL" width="49%"/>
  <img src="docs/screenshots/iq-visualizers.png" alt="Page-5 IQ visualizers — SFRC, DOPP, ZOOM" width="49%"/>
</p>

<p align="center">
  <img src="docs/screenshots/mobile.png" alt="Touch-first keypad UI on a phone" width="40%"/>
</p>

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
