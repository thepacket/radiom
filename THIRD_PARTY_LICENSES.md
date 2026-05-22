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

| Decoder dir         | Upstream project           | Upstream source                                                                 | License                |
|---------------------|----------------------------|---------------------------------------------------------------------------------|------------------------|
| `decoders/ft8/`     | ft8_lib (Kostas Karvouniaris) | https://github.com/kgoba/ft8_lib                                              | MIT                    |
| `decoders/freedv/`  | codec2 / FreeDV (David Rowe) | https://github.com/drowe67/codec2                                              | LGPL-2.1               |
| `decoders/wspr/`    | wsjt-x (Joe Taylor et al.) | https://git.code.sf.net/p/wsjt/wsjtx                                            | GPL-3.0-or-later       |
| `decoders/jt9/`     | wsjt-x                     | https://git.code.sf.net/p/wsjt/wsjtx                                            | GPL-3.0-or-later       |
| `decoders/fst4/`    | wsjt-x                     | https://git.code.sf.net/p/wsjt/wsjtx                                            | GPL-3.0-or-later       |
| `decoders/js8/`     | JS8Call (Jordan Sherer)    | https://bitbucket.org/widefido/js8call                                          | GPL-3.0-or-later       |
| `decoders/multimon/`| multimon-ng (Elias Önal)   | https://github.com/EliasOenal/multimon-ng                                       | GPL-2.0-or-later       |
| `decoders/packet/`  | direwolf (John Langner)    | https://github.com/wb2osz/direwolf                                              | GPL-2.0-or-later       |
| `decoders/hfdl/`    | dumphfdl + libacars (Tomasz Lemiech) | https://github.com/szpajder/dumphfdl<br>https://github.com/szpajder/libacars  | GPL-3.0-or-later       |
| `decoders/sstv/`    | slowrxd (Stuart Longland fork of slowrx) | https://github.com/sjlongland/slowrxd                              | GPL-2.0-or-later       |
| `decoders/ale-2g/`  | LinuxALE (Charles Brain, Ilkka Toivanen) | vendored under `decoders/ale-2g/linuxale/`                          | GPL-2.0-or-later       |
| `decoders/*-fldigi/`| fldigi (Dave Freese et al.) — cherry-picked DSP/protocol files | https://git.code.sf.net/p/fldigi/fldigi                | GPL-3.0-or-later       |

## NPM runtime dependencies

| Package                  | Upstream                                            | License        |
|--------------------------|-----------------------------------------------------|----------------|
| `@jitsi/rnnoise-wasm`    | https://github.com/jitsi/rnnoise-wasm               | BSD-3-Clause   |
| `ws`                     | https://github.com/websockets/ws                    | MIT            |

## Combined-work licensing

radiom's own source and the runtime Docker image both link cherry-picked
fldigi sources plus several GPL decoder binaries, so the **combined work is
GPL-3.0-or-later**. Anyone redistributing a built binary that bundles these
upstreams must comply with the GPL terms (including making corresponding
source available).
