# Third-Party Licenses

radiom itself is licensed under **GPL-3.0-or-later** (see [LICENSE](LICENSE)).
In addition, the build pipeline downloads, compiles, and bundles a number of
third-party decoders and libraries — most of which are also GPL-licensed —
so binary distributions (including the published Docker image) must comply
with GPL-3.0-or-later as the strictest applicable upstream license.

This file lists every upstream that radiom's `decoders/*/build.sh` scripts and
the [Dockerfile](Dockerfile) pull in, along with the license terms they ship
under. Source code for these upstreams is **not** committed to this repository
— each build script clones the canonical source from its upstream and compiles
it locally / inside the Docker stage.

## Decoder upstreams

### Narrowband digital text + imaging

| Decoder dir            | Upstream project                              | Upstream source                                              | License            |
|------------------------|-----------------------------------------------|--------------------------------------------------------------|--------------------|
| `decoders/ft8/`        | ft8_lib (Kostas Karvouniaris)                 | https://github.com/kgoba/ft8_lib                             | MIT                |
| `decoders/freedv/`     | codec2 / FreeDV (David Rowe)                  | https://github.com/drowe67/codec2                            | LGPL-2.1           |
| `decoders/wspr/`       | wsjt-x (Joe Taylor et al.)                    | https://git.code.sf.net/p/wsjt/wsjtx                         | GPL-3.0-or-later   |
| `decoders/jt9/`        | wsjt-x                                        | https://git.code.sf.net/p/wsjt/wsjtx                         | GPL-3.0-or-later   |
| `decoders/fst4/`       | wsjt-x                                        | https://git.code.sf.net/p/wsjt/wsjtx                         | GPL-3.0-or-later   |
| `decoders/msk144/`     | wsjt-x                                        | https://git.code.sf.net/p/wsjt/wsjtx                         | GPL-3.0-or-later   |
| `decoders/js8/`        | JS8Call (Jordan Sherer)                       | https://bitbucket.org/widefido/js8call                       | GPL-3.0-or-later   |
| `decoders/*-fldigi/`   | fldigi — cherry-picked DSP / protocol files   | https://git.code.sf.net/p/fldigi/fldigi                      | GPL-3.0-or-later   |
| `decoders/mfsk-fldigi/`| fldigi (shared stub/glue pool used by every other `*-fldigi/`) | (same)                                       | GPL-3.0-or-later   |
| `decoders/cw/`         | from-scratch (radiom)                         | this repo                                                    | GPL-3.0-or-later   |
| `decoders/navtex/`     | fldigi navtex                                 | https://git.code.sf.net/p/fldigi/fldigi                      | GPL-3.0-or-later   |
| `decoders/wefax/`      | fldigi wefax                                  | https://git.code.sf.net/p/fldigi/fldigi                      | GPL-3.0-or-later   |
| `decoders/rsid/`       | fldigi rsid (auto-classifier)                 | https://git.code.sf.net/p/fldigi/fldigi                      | GPL-3.0-or-later   |
| `decoders/sstv/`       | slowrxd (Stuart Longland fork of slowrx)      | https://github.com/sjlongland/slowrxd                        | GPL-2.0-or-later   |
| `decoders/ale-2g/`     | LinuxALE (Charles Brain, Ilkka Toivanen)      | vendored under `decoders/ale-2g/linuxale/`                   | GPL-2.0-or-later   |

### Paging / selective calling / generic FSK

| Decoder dir         | Upstream project           | Upstream source                              | License            |
|---------------------|----------------------------|----------------------------------------------|--------------------|
| `decoders/multimon/`| multimon-ng (Elias Önal) — handles POCSAG / SELCAL / FLEX / FLEX_NEXT / DTMF / ZVEI{1,2,3} / DZVEI / PZVEI / EEA / EIA / CCIR / X10 / EAS / AFSK1200 / AFSK2400{,_2,_3} / UFSK1200 / CLIPFSK / FMSFSK / HAPN4800 / FSK9600 / MORSE_CW | https://github.com/EliasOenal/multimon-ng | GPL-2.0-or-later   |

### Packet (AX.25 / APRS / IL2P)

| Decoder dir         | Upstream project           | Upstream source                              | License            |
|---------------------|----------------------------|----------------------------------------------|--------------------|
| `decoders/packet/`  | direwolf (John Langner) — 300 baud HF / 1200 baud VHF / 9600 G3RUH / IL2P framing + AGW Packet Engine server | https://github.com/wb2osz/direwolf | GPL-2.0-or-later   |

### Aviation data links

| Decoder dir       | Upstream project                              | Upstream source                              | License            |
|-------------------|-----------------------------------------------|----------------------------------------------|--------------------|
| `decoders/acars/` | acarsdec (f00b4r0 fork — native stdin streaming) | https://github.com/f00b4r0/acarsdec        | GPL-2.0            |
| `decoders/vdl2/`  | dumpvdl2 (Tomasz Lemiech)                     | https://github.com/szpajder/dumpvdl2         | GPL-3.0-or-later   |
| `decoders/hfdl/`  | dumphfdl + libacars (Tomasz Lemiech)          | https://github.com/szpajder/dumphfdl<br>https://github.com/szpajder/libacars | GPL-3.0-or-later |
| `decoders/adsb/`  | dump1090-fa (FlightAware)                     | https://github.com/flightaware/dump1090      | GPL-2.0-or-later   |
| `decoders/uat/`   | dump978-fa (FlightAware)                      | https://github.com/flightaware/dump978       | GPL-2.0-or-later   |
| `decoders/jaero/` | inmarsat-sniffer (alphafox02) — used by both AERO and STD-C bridges (`--mode=aero` / `--mode=stdc`) | https://github.com/alphafox02/inmarsat-sniffer | GPL-2.0-or-later |
| `decoders/op25/`  | op25 (boatbod fork — actively maintained P25 trunking) | https://github.com/boatbod/op25     | GPL-3.0-or-later   |

### Maritime

| Decoder dir         | Upstream project                              | Upstream source                                | License            |
|---------------------|-----------------------------------------------|------------------------------------------------|--------------------|
| `decoders/ais/`     | aisdecoder (hessu fork of aishub.net's gnuais lineage) | https://github.com/hessu/aisdecoder   | GPL-2.0-or-later   |
| `decoders/dsc/`     | DSC-Codec (jbirby) — Python ITU-R M.493 decoder | https://github.com/jbirby/DSC-Codec          | MIT                |
| `decoders/cospas/`  | COSPAS-SARSAT-406-MHz-Beacon-Codec (jbirby) — Python C/S T.001 + T.018 decoder | https://github.com/jbirby/COSPAS-SARSAT-406-MHz-Beacon-Codec | MIT |

### Digital voice

| Decoder dir       | Upstream project                              | Upstream source                              | License            |
|-------------------|-----------------------------------------------|----------------------------------------------|--------------------|
| `decoders/dsd/`   | dsd-fme (lwvmobile, audio_work branch) — handles D-STAR / DMR / DMR-stereo / NXDN-48/96 / YSF / dPMR / M17 / P25-P1 / P25-P2 | https://github.com/lwvmobile/dsd-fme | ISC + GPL-2.0 |

### Satellite imagery + telemetry

| Decoder dir         | Upstream project           | Upstream source                              | License            |
|---------------------|----------------------------|----------------------------------------------|--------------------|
| `decoders/lrpt/`    | SatDump — covers LRPT (Meteor M2) / HRPT (NOAA) / APT (NOAA) pipelines | https://github.com/SatDump/SatDump | GPL-3.0-or-later   |
| `decoders/sonde/`   | rs1729/RS — RS41 / DFM-09 / M10 / iMet-54 / LMS6X / MP3H1 radiosondes | https://github.com/rs1729/RS    | GPL-2.0-or-later (per-file)  |

### ISM / SDR / RF

| Decoder dir         | Upstream project                              | Upstream source                              | License            |
|---------------------|-----------------------------------------------|----------------------------------------------|--------------------|
| `decoders/rtl433/`  | rtl_433 (merbanan) — ~200 ISM-band device protocols | https://github.com/merbanan/rtl_433    | GPL-2.0-or-later   |
| `decoders/lora/`    | gr-lora_sdr (EPFL TCL, Joachim Tapparel)      | https://github.com/tapparelj/gr-lora_sdr     | GPL-3.0-or-later   |
| `decoders/rds/`     | redsea (Oona Räisänen / windytan) — FM broadcast RDS | https://github.com/windytan/redsea    | MIT                |
| `decoders/ltr/`     | GopherTrunk — LTR-Net trunked dispatch decoder | (vendored)                                  | GPL-2.0-or-later   |

## Build / runtime system dependencies

Beyond the per-decoder upstreams above, the Docker runtime image installs the
following system packages (Debian Bookworm) to satisfy shared-library and
language-runtime requirements for the decoders that link against them:

| Package family                 | Used by                                                |
|--------------------------------|--------------------------------------------------------|
| GNU Radio 3.10 + gr-osmosdr    | OP25 (`boatbod/op25`), LoRa (`gr-lora_sdr`)            |
| Python 3 + numpy / pybind11 / waitress / requests | OP25, LoRa, DSC, COSPAS              |
| libboost-{program-options,regex,filesystem,system} | UAT (`dump978-fa`)                |
| libsoapysdr0.8                 | UAT                                                    |
| libasound2                     | AIS (`aisdecoder` — cmake hard-fails without ALSA or PulseAudio headers, even with the `file` driver) |
| libfftw3-single3 / libfftw3-double3 | SatDump, fldigi-derived decoders                  |
| libvolk2.5, libnng1, libjemalloc2 | SatDump                                             |
| libsndfile1                    | acarsdec, sonde decoders                               |
| libgomp1                       | SatDump (`-fopenmp`)                                   |
| libtiff6, libjpeg62-turbo      | SatDump (image-product writers)                        |
| libcjson1                      | acarsdec (JSON output)                                 |
| libcurl4                       | SatDump (IERS / TLE downloads), op25                   |
| ca-certificates                | HTTPS for SatDump's IERS/TLE fetch                     |
| libcodec2-1.0                  | dsd-fme (vocoder), FreeDV                              |
| librtlsdr0                     | dump1090, dump978                                      |
| libpulse0, liblapack3, libusb-1.0-0, libncurses{6,w6}, libtinfo6 | dsd-fme |

All system packages installed via apt are subject to their respective Debian
package licenses (overwhelmingly LGPL / BSD / MIT). They are linked dynamically
at runtime, not redistributed as part of radiom itself.

## NPM runtime dependencies

| Package                  | Upstream                                            | License        |
|--------------------------|-----------------------------------------------------|----------------|
| `@jitsi/rnnoise-wasm`    | https://github.com/jitsi/rnnoise-wasm               | BSD-3-Clause   |
| `ws`                     | https://github.com/websockets/ws                    | MIT            |
| `http-proxy`             | https://github.com/http-party/node-http-proxy       | MIT            |

## Retired upstreams

The following upstreams were investigated or briefly vendored but are no
longer wired into the build. Their `decoder/<x>.mjs` and `decoders/<x>/`
files may remain in the tree for git history but no Dockerfile stage builds
them and no UI button reaches them:

| Upstream                              | Why retired |
|---------------------------------------|-------------|
| `sysmocom/tetrapol-kit`               | Repository doesn't exist on GitHub. The maintained fork (`airphel/tetrapol-kit-2023`) builds `tetrapol_dump` but that binary needs pre-demodulated bits from a separate GR Python flowgraph we don't ship. |
| `wmbusmeters/wmbusmeters`             | It's a telegram parser, not an IQ demodulator. radiom feeds raw IQ; the IQ→telegram demod step (`rtl_wmbus`) isn't shipped. `rtl_433` covers wmbus traffic natively for most devices. |
| `dokutan/dcf77-decode` (TIME button)  | Takes pre-decoded ASCII bit lines, not audio. No AM-envelope+pulse-width demod layer in radiom. |
| `sigsegv-mvm/scytale-c`               | Repository doesn't exist on GitHub. Replaced by `alphafox02/inmarsat-sniffer --mode=stdc` (same binary as JAERO). |
| `zleffke/gr-sarsat`                   | GNU Radio OOT module with no usable standalone CLI. Replaced by `jbirby/COSPAS-SARSAT-406-MHz-Beacon-Codec` (Python). |
| `mutability/dump1090`                 | Archived in 2026. Replaced by `flightaware/dump1090`. |
| `mutability/dump978`                  | Archived in 2026. Replaced by `flightaware/dump978`. |
| `dgiardini/rtl-ais`                   | Builds only `rtl_ais` (RTL-SDR-hardware-only); has no audio-input binary. Replaced by `hessu/aisdecoder`. |
| `osmocom/op25`                        | Less actively maintained than the boatbod fork. Replaced by `boatbod/op25`. |
| `TLeconte/acarsdec`                   | No native stdin streaming. Replaced by `f00b4r0/acarsdec`. |
| `jontio/JAERO`                        | Qt-GUI only, no headless CLI. Replaced by `alphafox02/inmarsat-sniffer`. |
| `altillimity/SatDump`                 | Org renamed → `SatDump/SatDump` (same project, redirected). |
| `moricef/Decode_sarsat_406_v1g_v2g`   | CC BY-NC-SA (non-commercial); incompatible with GPL-3.0 redistribution. |
| ERMES (multimon-ng mode)              | Not actually a multimon-ng demodulator — was a mode-name typo. Protocol is also decommissioned across Europe since ~2010. |

## Combined-work licensing

radiom's own source and the runtime Docker image both link cherry-picked
fldigi sources plus several GPL decoder binaries, so the **combined work is
GPL-3.0-or-later**. Anyone redistributing a built binary that bundles these
upstreams must comply with the GPL terms (including making corresponding
source available).
