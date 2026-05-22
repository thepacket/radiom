# radiom

A KiwiSDR-based web HF receiver with a large built-in decoder library
(CW, RTTY, FT8/FT4, WSPR, JT9/JT65, FST4, JS8, NAVTEX, WEFAX, HFDL, ALE 2G,
SSTV, FreeDV, Olivia, MFSK, MT63, Throb, and ~30 others).

The browser app connects to any [KiwiSDR](https://kiwisdr.com) server, streams
audio + waterfall, and routes the audio through a fleet of decoder bridges
running on a small Node backend.

## Screenshots

See [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md) for the full gallery.

### Decoder library (~40 protocols)

| Protocol            | Vendored from         | Presets / variants available in-app |
|---------------------|-----------------------|-------------------------------------|
| CW                  | from-scratch          | Single decoder, adjustable WPM bias |
| MCW                 | AM + CW chain         | — (uses the CW decoder) |
| RTTY                | fldigi rtty           | 17 presets: 170 Hz amateur (45.45 / 75 baud, low / mid / high pitch), 50 / 60 / 75 / 100 baud commercial, UK 200/50, Russian 200/100 + 250/75 + 450/75, DWD 425 weather, TASS 425 press, 850 Hz, 1000 Hz custom |
| PSK (BPSK)          | fldigi psk            | PSK31, 63, 63F, 125, 250, 500, 1000, PSK125R / 250R / 500R / 1000R |
| QPSK                | fldigi psk            | QPSK31, 63, 125, 250, 500 |
| 8PSK                | fldigi psk            | 125 / 125FL / 125F, 250 / 250FL / 250F, 500 / 500F, 1000 / 1000F, 1200F |
| MFSK                | fldigi mfsk           | MFSK4, 8, 11, 16, 22, 31, 32, 64, 128 |
| Olivia              | fldigi olivia         | 18 (tones × bandwidth) presets: 4/125 … 64/2000 |
| Contestia (CTSA)    | fldigi contestia      | Same (tones × bandwidth) grid as Olivia |
| MT63                | fldigi mt63           | 500S, 500L, 1000S, 1000L, 2000S, 2000L |
| DominoEX (DOMEX)    | fldigi dominoex       | DEX 4, 5, 7-8, 8, 11, 11-FEC, 16, 22 |
| THOR                | fldigi thor           | THOR 4, 5, 8, 11, 16, 22, 25×4, 50×1, 50×2, 100 |
| Throb (THRB)        | fldigi throb (v2)     | Throb 1, 2, 4 + Throb-X variants |
| PI4                 | fldigi pi4 (v2)       | Single mode (beacon ID) |
| FSQ                 | fldigi fsq            | FSQ 1.5 / 3 / 4.5 / 6 baud |
| FT8                 | from-scratch ft8/ft4  | 15-s slot decoder |
| FT4                 | from-scratch ft8/ft4  | 7.5-s slot decoder |
| JT4                 | WSJT-X jt9 -4         | sub-modes A–G |
| JT9                 | WSJT-X jt9 -9         | — |
| JT65                | WSJT-X jt9 -65        | — |
| Q65                 | WSJT-X jt9 -q         | Q65-A, B, C, D, E |
| FST4                | WSJT-X fst4d          | TR 60 / 120 / 300 / 900 / 1800 s |
| FST4W               | WSJT-X fst4d -W       | TR 60 / 120 / 300 / 900 / 1800 s |
| WSPR                | WSJT-X wsprd          | 2-min slots, 11 standard sub-bands |
| WSPR-15 (W15)       | WSJT-X wsprd -m       | 15-min slots (LF / MF), aligned to :00/:15/:30/:45 UTC |
| JS8                 | js8call               | Normal, Slow, Fast, Turbo, Ultra |
| ARDOP               | pflarue/ardopcf       | 200 / 500 / 1000 / 2000 Hz BW |
| HF packet (PKT)     | direwolf              | 300-baud AX.25 / APRS on 30 m |
| HFDL                | szpajder/dumphfdl     | KiwiSDR IQ-mode, configurable channel |
| NAVTEX              | fldigi navtex         | SITOR-B FEC broadcast |
| SITOR               | fldigi navtex (B)     | Same engine, free-tuned dial |
| WEFAX (FAX)         | fldigi wefax          | IOC 576 / 288, multiple LPM (60/90/120/240), B&W / colour |
| SSTV                | sjlongland/slowrxd    | Robot, Martin (M1/M2), Scottie (S1/S2/DX), PD, MP, MR, BW, multiple sub-modes per family |
| Hellschreiber (HELL)| from-scratch (AM)     | Feld-Hell (AM-only render) |
| FreeDV (FDV)        | drowe67/codec2        | 700C / 700D / 700E / 1600 / 2020 (codec2 freedv_rx default selection) |
| ALE 2G              | LinuxALE              | MIL-STD-188-141A/B |
| SELCAL (SELC)       | EliasOenal/multimon-ng | Aircraft 4-char SELCAL — same binary also handles POCSAG / FLEX / EAS / ZVEI / DTMF / FMSFSK |
| WWV                 | fldigi wwv            | WWV / WWVH minute-tick decoder |
| iSB                 | client-side IQ        | Independent-sideband stereo demod (LSB → L, USB → R) |
| ECSS                | client-side IQ        | Exalted-carrier SSB (PLL-locked AM demod) |
| QRSS                | client-side audio FFT | Very-slow CW grabber (visual decoder) |
| STANAG 4285         | from-scratch detector | Lock detection only (no payload) |
| STANAG 4539         | from-scratch detector | Lock detection only (no payload) |
| RSID                | fldigi RSID           | Autonomous mode-ID decoder; auto-switches the active decoder when an RSID-bearing transmission identifies the mode in use |

[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) lists the upstream
project each decoder is vendored from.

### Integrated signal generator (GEN button)

Every shipped decoder can be exercised without a live HF signal via the
**GEN** button in the function row. It opens a categorised picker
(`openModesPicker`) of curated test samples — synthesized reference
transmissions plus a handful of real off-air recordings — covering CW,
RTTY (every shift / baud combination listed above), all BPSK / QPSK /
8PSK rates, every MFSK / Olivia / Contestia / MT63 / DominoEX / THOR /
Throb variant, FSQ, FT4 / FT8 / FST4 / WSPR / JS8 / JT9 / JT65,
NAVTEX, WEFAX, SSTV, Hellschreiber, ALE, packet, IFKP, and WWV.

The selected sample is decoded to a 12 kHz mono Int16 buffer via
`OfflineAudioContext` (proper anti-aliased resampling, not linear
interp), then routed through the active decoder using the same audio
fan-out path as live KiwiSDR audio. This is the canonical regression
test for any decoder change — the inject path is one of the things the
in-tree audio samples (`audio/<mode>/*.mp3|wav`) were captured / generated
for.

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
