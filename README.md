# radiom

A multi-source mobile web SDR client with a large built-in decoder library
(88 protocols covering CW / RTTY / FT8/FT4 / WSPR / JT9/JT65 / FST4 /
JS8 / NAVTEX / WEFAX / HFDL / ALE 2G / Olivia / MFSK / MT63 / Throb /
ACARS / VDL-2 / ADS-B / AIS / DSC / DMR / NXDN / YSF / M17 / P25 /
LRPT / APT / HRPT / LoRa / rtl_433 / SONDE / OP25 / AERO / STD-C / and
~50 others).

The browser app connects to one of three SDR-server flavors and routes
the demodulated audio (or raw IQ, where appropriate) through a fleet
of decoder bridges running on a small Node backend:

- **[KiwiSDR](https://kiwisdr.com)** — source for HF
  (0–30 MHz) audio and IQ stream. 
- **[OpenWebRX](https://www.openwebrx.de)** — second source supporting
  HF and VHF/UHF when the host has appropriate front-ends. Used for
  bands above 30 MHz when the operator has access to an OWRX-fronted
  receiver.
- **rtl_tcp** — third source for direct RTL-SDR access (typically
  via a remote RTL-SDR USB receiver exposed over TCP). Required for
  the IQ-baseband decoders that need ≥1 MS/s (ADS-B at 1090 MHz, UAT
  at 978 MHz, AERO / STD-C at L-band, LRPT / HRPT, OP25 trunking, etc.).

The active source is selected from the top bar; each decoder
indicates in its tooltip whether it requires an IQ-capable source
(rtl_tcp / OWRX) or works with the audio chain from any source.

> **Status: actively being tested.** radiom is an advanced mobile-first
> receiver with a large surface area — many features still need real-world
> validation across receivers, bands, and propagation conditions, and more
> decoders / visualizers are on the way. Bug reports and on-air results are
> very welcome (see [Getting in touch](#getting-in-touch)).
>
> **This README is a draft** and does not list every shipped feature.

## Screenshots

NOTE: The user interface has been significantly modified since the last screenshots.

See [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md) for a gallery of a small subset of the features.

### Decoder library (88 protocols)

Alphabetical. Multiple decoders share a binary (e.g. `jt9` covers four
WSJT-X modes, `dsd-fme` covers ten digital-voice modes, `multimon-ng`
covers twenty paging/selcall modes, `direwolf` covers four packet
variants, `inmarsat-sniffer` covers AERO + STD-C).

| Protocol            | Vendored from              | Variants / notes |
|---------------------|----------------------------|------------------|
| 9600 Packet         | direwolf (MODEM 9600)      | G3RUH scrambled NRZ, FOX cubesats + 70 cm — needs wideband (≥24 kHz) audio |
| ACARS               | f00b4r0/acarsdec           | 131 MHz airline data link, MSK 2400 bps |
| ADS-B               | flightaware/dump1090       | 1090 MHz Mode-S extended squitter |
| AERO                | alphafox02/inmarsat-sniffer | Inmarsat AERO Classic (--mode=aero), L-band IQ |
| AFSK1200            | EliasOenal/multimon-ng     | Bell-202 AFSK 1200 bps (APRS, weather sondes…) |
| AFSK2400            | EliasOenal/multimon-ng     | Three tone-pair variants (AFSK2400 / _2 / _3) run concurrently |
| AIS                 | hessu/aisdecoder (gnuais)  | 161.975 / 162.025 MHz marine vessel tracking |
| ALE 2G              | LinuxALE                   | MIL-STD-188-141A/B |
| AMTOR               | fldigi navtex (B)          | FEC mode of SITOR-B |
| APT                 | SatDump (noaa_apt)         | NOAA analog APT @ 137 MHz |
| CCIR                | EliasOenal/multimon-ng     | ITU-R 5-tone selcall |
| CCITT               | multimon-ng (→ CCIR)       | ITU-T 5-tone — same tone table, routed via CCIR |
| CLIPFSK             | EliasOenal/multimon-ng     | Bellcore / ETSI Caller-ID V.23 FSK |
| Contestia (CTSA)    | fldigi contestia           | Same (tones × bandwidth) grid as Olivia |
| CSPAS               | jbirby/COSPAS-SARSAT-Codec | 406 MHz ELT / EPIRB / PLB (1G + 2G) |
| CW                  | from-scratch + fldigi      | Single decoder, adjustable WPM bias |
| CWM                 | EliasOenal/multimon-ng     | multimon-ng's native Morse (cross-check against CW) |
| D-STAR              | lwvmobile/dsd-fme (-fd)    | DV+DD digital voice, AMBE2+ |
| DMR                 | dsd-fme (-ft)              | ETSI Tier-2, single-slot |
| DMR-stereo          | dsd-fme (-fs)              | Decodes both TDMA slots concurrently (slot1=L, slot2=R) |
| DominoEX (DOMEX)    | fldigi dominoex            | DEX 4, 5, 7-8, 8, 11, 11-FEC, 16, 22 |
| dPMR                | dsd-fme (-fz)              | dPMR446 (EU low-power business) |
| DSC                 | jbirby/DSC-Codec (Python)  | ITU-R M.493 marine VHF Ch 70 + HF guard channels |
| DTMF                | EliasOenal/multimon-ng     | Touch-tone digits |
| DZ/PZVEI            | EliasOenal/multimon-ng     | German + Polish ZVEI dialects, bundled |
| EAS                 | EliasOenal/multimon-ng     | Emergency Alert System SAME headers |
| EEA                 | EliasOenal/multimon-ng     | European EAS-variant selcall |
| EIA                 | EliasOenal/multimon-ng     | European industrial-alert selcall |
| EURO                | multimon-ng (→ EEA)        | Generic EU 5-tone, routed via EEA |
| FLEX                | EliasOenal/multimon-ng     | 1600/3200/6400 bps 2/4-FSK paging |
| FLEX_NEXT           | EliasOenal/multimon-ng     | Newer FLEX revision, additive demod |
| FMSFSK              | EliasOenal/multimon-ng     | German FMS Funkmeldesystem 1200 bps |
| FreeDV              | freedv_rx                  | 700C / 700D / 700E / 1600 / 2020 digital voice |
| FSK9600             | EliasOenal/multimon-ng     | Generic 9600 bps NRZ FSK |
| FSQ                 | fldigi fsq                 | FSQ 1.5 / 3 / 4.5 / 6 baud |
| FST4                | WSJT-X fst4d               | TR 60 / 120 / 300 / 900 / 1800 s |
| FST4W               | WSJT-X fst4d -W            | TR 60 / 120 / 300 / 900 / 1800 s |
| FT4                 | from-scratch ft8/ft4       | 7.5-s slot decoder |
| FT8                 | from-scratch ft8/ft4       | 15-s slot decoder |
| HAPN4800            | EliasOenal/multimon-ng     | Hong Kong amateur packet 4800 bps FSK |
| HF Packet           | direwolf (MODEM 300)       | 300-baud AX.25 / APRS on 30 m |
| HFDL                | szpajder/dumphfdl          | HF data link (multiple ground stations), IQ-mode |
| HRPT                | SatDump (noaa_hrpt)        | NOAA AVHRR HRPT @ L-band |
| IL2P Packet         | direwolf (-d 2)            | Nino Carrillo's Reed-Solomon FEC framing on VHF 1200 |
| JS8                 | js8call                    | Normal, Slow, Fast, Turbo, Ultra |
| JT4                 | WSJT-X jt9 -4              | sub-modes A–G |
| JT65                | WSJT-X jt9 -65             | — |
| JT9                 | WSJT-X jt9 -9              | — |
| LoRa                | tapparelj/gr-lora_sdr      | EU 868 / US 915 / AS 433 MHz, SF7–12, BW 125/250/500 kHz |
| LRPT                | SatDump (meteor_m2_lrpt)   | Meteor M2 weather sat @ 137 MHz |
| LTR                 | GopherTrunk                | LTR-Net trunked dispatch |
| M17                 | dsd-fme (-fU)              | M17 open digital voice |
| MFSK                | fldigi mfsk                | MFSK4, 8, 11, 16, 22, 31, 32, 64, 128 |
| MSK144              | WSJT-X msk144d             | Meteor-scatter |
| MT63                | fldigi mt63                | 500S, 500L, 1000S, 1000L, 2000S, 2000L |
| NAVTEX              | fldigi navtex              | SITOR-B FEC broadcast (490 / 518 kHz / 4209.5 kHz) |
| NXDN-48             | dsd-fme (-fn)              | NXDN 4800 (narrow, Kenwood / Icom) |
| NXDN-96             | dsd-fme (-fN)              | NXDN 9600 (wider variant) |
| Olivia              | fldigi olivia              | 18 (tones × bandwidth) presets: 4/125 … 64/2000 |
| OP25                | boatbod/op25 (rx.py)       | P25 trunking + control-channel parsing, IQ-mode |
| P25-P1              | dsd-fme (-fp)              | P25 Phase 1 (CQPSK) — single-channel |
| P25-P2              | dsd-fme (-f2)              | P25 Phase 2 (HDQPSK) — single-channel |
| PACTOR              | fldigi navtex (B)          | Same engine, free-tuned dial |
| POCSAG              | multimon-ng (POCSAG{512,1200,2400}) | Pager protocol, all three baud rates |
| PSK (BPSK)          | fldigi psk                 | PSK31, 63, 63F, 125, 250, 500, 1000, PSK125R/250R/500R/1000R |
| Q65                 | WSJT-X jt9 -q              | Q65-A, B, C, D, E |
| QRSS                | from-scratch (DSP)         | Slow-CW visual decoder |
| RDS                 | windytan/redsea            | FM broadcast Radio Data System |
| rtl_433             | merbanan/rtl_433           | ~200 ISM-band protocols (weather, TPMS, meters, …) |
| RTTY                | fldigi rtty                | 17 presets: 170 Hz amateur, 50/60/75/100 baud commercial, UK 200/50, Russian 200/100/250/75/450/75, DWD/TASS 425, 850/1000 Hz custom |
| SELCAL              | EliasOenal/multimon-ng     | Aviation HF 4-char SELCAL (-a CCIR) |
| SITOR-A             | from-scratch               | ARQ mode (full 7-char block) |
| SITOR-B             | fldigi navtex (B)          | FEC broadcast mode |
| SONDE               | rs1729/RS (rs41mod et al.) | Radiosondes — RS41, DFM-09, M10, iMet-54, LMS6, MP3H1 |
| STD-C               | alphafox02/inmarsat-sniffer | Inmarsat-C SOLAS messaging (--mode=stdc) |
| THOR                | fldigi thor                | THOR 4, 5, 8, 11, 16, 22, 25×4, 50×1, 50×2, 100 |
| Throb (THRB)        | fldigi throb               | Throb 1, 2, 4 + Throb-X variants |
| UAT                 | flightaware/dump978-fa     | 978 MHz US general-aviation ADS-B variant |
| UFSK1200            | EliasOenal/multimon-ng     | Universal FSK 1200 bps (telematics, telemetry) |
| VDL-2               | szpajder/dumpvdl2          | 136 MHz aviation data link (12 channels concurrent) |
| VHF Packet          | direwolf (MODEM 1200)      | 144.39 (US) / 144.80 (EU) MHz APRS, Bell-202 |
| WEFAX               | fldigi wefax               | IOC 576 / 288, multiple LPM, B&W + colour |
| WSPR                | WSJT-X wsprd               | 2-min slots, 11 standard sub-bands |
| WSPR-15             | WSJT-X wsprd -m            | 15-min slots (LF / MF), aligned to :00/:15/:30/:45 UTC |
| WWV                 | fldigi wwv                 | WWV / WWVH minute-tick decoder |
| X10                 | EliasOenal/multimon-ng     | X10 home-automation RF (310 MHz) |
| YSF                 | dsd-fme (-fy)              | Yaesu System Fusion / C4FM |
| ZVEI                | EliasOenal/multimon-ng     | ZVEI1 + ZVEI2 + ZVEI3 selcall, bundled |

Additional cross-cutting tooling:
- **AGW Packet Engine** server (TCP 8000) exposed by all four packet
  variants for APRSIS32 / UI-View / Xastir clients (RX-only).
- **APRS telemetry** (T# / PARM / UNIT / EQNS / BITS) decoded inline
  by all packet modes — direwolf's structured-payload parser is on.
- **RSID auto-classifier** vendored from fldigi for autonomous mode
  detection — runs alongside the AUTO panel and switches the active
  decoder.

[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) lists the upstream
project each decoder is vendored from.

### Integrated signal generator (GEN button)

Some shipped decoder can be exercised without a live HF signal via the
**GEN** button in the function row. It opens a categorised picker
(`openModesPicker`) of curated test samples — synthesized reference
transmissions plus a handful of real off-air recordings — covering CW,
RTTY (every shift / baud combination listed above), all BPSK / QPSK /
8PSK rates, every MFSK / Olivia / Contestia / MT63 / DominoEX / THOR /
Throb variant, FSQ, FT4 / FT8 / FST4 / WSPR / JS8 / JT9 / JT65,
NAVTEX, WEFAX, Hellschreiber, ALE, packet, IFKP, and WWV.

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

## Getting in touch

- **[Issues](https://github.com/thepacket/radiom/issues)** — bug reports,
  feature requests, decoder problems, build failures.
- **[Discussions](https://github.com/thepacket/radiom/discussions)** — open
  questions, "how do I…", on-air results, ideas you want to talk through
  before opening an issue.
- **Security** — for anything sensitive, please use GitHub's private
  [security advisories](https://github.com/thepacket/radiom/security/advisories/new)
  rather than a public issue.

## Contributing

radiom is a personal project, open-sourced so others can read the code,
and fork it for their own use. **Pull requests are not
accepted** — the codebase stays solo-authored. Bug reports, on-air
results, and ideas are very welcome through
[Issues](https://github.com/thepacket/radiom/issues) and
[Discussions](https://github.com/thepacket/radiom/discussions); anything
that lands in the upstream codebase will be implemented from there.

## Authorship

Every line of application code in this repository was written by
[Claude Code](https://claude.com/claude-code) (Anthropic) under the direction
of Andre Paquette — design decisions, decoder selection, and on-air
validation were human-driven; the actual TypeScript, C/C++ glue,
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
