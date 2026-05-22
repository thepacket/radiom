# radiom

A KiwiSDR-based web HF receiver with a large built-in decoder library
(CW, RTTY, FT8/FT4, WSPR, JT9/JT65, FST4, JS8, NAVTEX, WEFAX, HFDL, ALE 2G,
SSTV, FreeDV, Olivia, MFSK, MT63, Throb, and ~30 others).

The browser app connects to any [KiwiSDR](https://kiwisdr.com) server, streams
audio + waterfall, and routes the audio through a fleet of decoder bridges
running on a small Node backend.

## Features

### Reception

- KiwiSDR client supporting AM / AMN / SAM / LSB / USB / CW / NBFM / IQ modes.
- Custom passband per mode plus low-cut / high-cut knobs (LoW / HiW).
- AGC with fast / medium / slow / off presets and a manual-gain fallback.
- Client-side squelch (stock KiwiSDR firmware ignores its own `SET squelch`;
  gating is applied in the player after decoder fan-out, so decoders keep
  seeing signal while the speakers go silent).
- Antenna-switch extension (slot 1..N on kiwis with the antenna switch
  configured).
- 3-band EQ + voice-track gain (anti-formant enhancer for SSB voice).
- AM notch filter, anti-carrier subtraction, and `SSB filtered` clean-up mode.
- Session recording (REC) to local WAV.
- KiwiSDR **v1.817+ bot-detector workarounds** — binary-frame SET commands,
  exact init order, `Origin: null`, HTTP-touch preflight (`/api/kiwi-touch`)
  for HTTPS pages talking to plain-HTTP kiwis, and `mod=` re-send after
  `rx_chan` is known. Without these, modern kiwis silently refuse to start
  the audio loop.

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

### Auto-classification

- **AUTO** — heuristic classifier on the audio stream (bandwidth + symbol-rate
  + tonality fingerprints) suggests likely modes in real time.
- **RSID** — fldigi's Reed-Solomon ID decoder, vendored RX-only. When an
  RSID-bearing transmission is received, the active decoder is switched
  automatically to match.

### Visualizers

- **Audio-domain** (page 6): EYE (eye diagram), SCOPE, S-METER, SPEC
  (spectrogram), SPLOT (S-plot strip), VECT (vectorscope), GRAY (grayscale
  waterfall variant), IQ VIEW (constellation), FMNT (formant tracker).
- **IQ-domain** (page 5, requires `mode=iq`): ANTC (anti-carrier subtraction),
  DOPP (Doppler-vs-time strip), OTHR (OTH-radar / chirp classifier), PPMC
  (kiwi clock self-calibration against a time-station carrier), RFI
  (switching-supply / RFI emitter sniffer), SFRC (sferic / lightning monitor),
  ZOOM (sub-Hz spectrogram via a long FFT).

### Waterfall

- WF1–8 row duplication with linear interpolation — fills the waterfall
  faster on low-FPS kiwis without producing visible duplicated bands.
- AUTO / DARK / DARK+ percentile-based auto-stretch (5/99, 30/99, 55/99.5)
  driven by a rolling histogram, smoothed by an EMA.
- 10-second no-data watchdog — surfaces a banner and drops the connection
  if neither audio nor waterfall frames arrive for >10 s.
- Click / tap to tune; drag to retune; long-press `+` to zoom to max.

### Frequency pickers + SCAN

- Per-decoder frequency pickers (long-press a decoder button to open a
  curated list of frequencies for that mode).
- Generic band pickers (page 8): broadcast (BCONS), military (MILV), maritime
  (MRINE), scientific (SCIEN), time stations (TIME), VLF beacons (VLFB),
  volunteer-monitored (VOLM).
- **Picker-driven SCAN** — the SCAN button cycles through the most-recently
  opened picker's list. Long-press starts; short-tap pauses / resumes.
  Per-frequency dwell is settable (1–60 s).

### Transcription

- Live-transcription of SSB voice using OpenAI's Whisper API (BYO API key,
  stored only in browser localStorage).
- Optional auto-translation to a target language.

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
