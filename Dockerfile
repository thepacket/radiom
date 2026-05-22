# ---- build stage (frontend) ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- wefax decoder native build ----
FROM debian:bookworm-slim AS wefax-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
# wefax now ships the vendored fldigi RX path (same pattern as cw).
WORKDIR /src
COPY decoders/wefax ./decoders/wefax
RUN mkdir -p /out && bash decoders/wefax/build.sh && cp decoders/wefax/bin/wefax-decoder /out/wefax-decoder

# ---- cw decoder native build (vendored fldigi RX path) ----
# Compiles decoders/cw/{main.cpp, fldigi_glue.cpp, fldigi/*.cxx} into a
# single Linux x86_64 ELF. The fldigi sources are RX-only (TX paths have
# been gutted to empty stubs) and the framework hooks are satisfied by
# decoders/cw/stubs/.
FROM debian:bookworm-slim AS cw-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
# build.sh expects the source to live at <root>/decoders/cw — preserve that
# layout so the relative `../..` math inside the script resolves correctly.
WORKDIR /src
COPY decoders/cw ./decoders/cw
RUN mkdir -p /out && bash decoders/cw/build.sh && cp decoders/cw/bin/cw-decoder /out/cw-decoder

# ---- navtex decoder native build (vendored fldigi RX path) ----
FROM debian:bookworm-slim AS navtex-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/navtex ./decoders/navtex
RUN mkdir -p /out && bash decoders/navtex/build.sh && cp decoders/navtex/bin/navtex-decoder /out/navtex-decoder

# ---- ale-2g decoder native build (vendored LinuxALE) ----
FROM debian:bookworm-slim AS ale-2g-build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/ale-2g ./decoders/ale-2g
RUN mkdir -p /out && bash decoders/ale-2g/build.sh && cp decoders/ale-2g/bin/ale-2g-decoder /out/ale-2g-decoder

# ---- HFDL decoder build (dumphfdl + libacars from upstream) ----
# dumphfdl is a self-contained CMake project; we don't vendor its source.
# build.sh inside the decoder dir clones pinned versions of libacars and
# dumphfdl, builds them against system liquid-dsp / fftw3 / glib, and
# emits the binary + libacars-2.so under decoders/hfdl/bin/. The runtime
# stage installs the small set of shared-library deps that dumphfdl
# links against (libliquid1, libfftw3-single3, libglib2.0-0, etc.).
FROM debian:bookworm-slim AS hfdl-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config git ca-certificates \
    libglib2.0-dev libconfig++-dev libliquid-dev \
    libfftw3-dev zlib1g-dev libxml2-dev libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/hfdl ./decoders/hfdl
RUN bash decoders/hfdl/build.sh && \
    mkdir -p /out && \
    cp decoders/hfdl/bin/dumphfdl /out/dumphfdl && \
    cp -P decoders/hfdl/bin/libacars-2.so* /out/

# ---- dominoex-fldigi decoder native build (vendored fldigi RX path) ----
FROM debian:bookworm-slim AS dominoex-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/dominoex-fldigi ./decoders/dominoex-fldigi
RUN mkdir -p /out && bash decoders/dominoex-fldigi/build.sh && cp decoders/dominoex-fldigi/bin/dominoex-fldigi-decoder /out/dominoex-fldigi-decoder

# ---- thor-fldigi decoder native build (vendored fldigi RX path) ----
FROM debian:bookworm-slim AS thor-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/thor-fldigi ./decoders/thor-fldigi
RUN mkdir -p /out && bash decoders/thor-fldigi/build.sh && cp decoders/thor-fldigi/bin/thor-fldigi-decoder /out/thor-fldigi-decoder

# ---- fsq-fldigi decoder native build (vendored fldigi RX path) ----
FROM debian:bookworm-slim AS fsq-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/fsq-fldigi ./decoders/fsq-fldigi
RUN mkdir -p /out && bash decoders/fsq-fldigi/build.sh && cp decoders/fsq-fldigi/bin/fsq-fldigi-decoder /out/fsq-fldigi-decoder

# ---- mt63-fldigi decoder native build (vendored fldigi RX path) ----
FROM debian:bookworm-slim AS mt63-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/mt63-fldigi ./decoders/mt63-fldigi
RUN mkdir -p /out && bash decoders/mt63-fldigi/build.sh && cp decoders/mt63-fldigi/bin/mt63-fldigi-decoder /out/mt63-fldigi-decoder

# ---- mfsk-fldigi decoder native build (vendored fldigi RX path) ----
FROM debian:bookworm-slim AS mfsk-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/mfsk-fldigi ./decoders/mfsk-fldigi
RUN mkdir -p /out && bash decoders/mfsk-fldigi/build.sh && cp decoders/mfsk-fldigi/bin/mfsk-fldigi-decoder /out/mfsk-fldigi-decoder

# ---- olivia-fldigi decoder native build (vendored fldigi RX path) ----
FROM debian:bookworm-slim AS olivia-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/olivia-fldigi ./decoders/olivia-fldigi
RUN mkdir -p /out && bash decoders/olivia-fldigi/build.sh && cp decoders/olivia-fldigi/bin/olivia-fldigi-decoder /out/olivia-fldigi-decoder

# ---- psk-fldigi decoder native build (vendored fldigi RX path) ----
FROM debian:bookworm-slim AS psk-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/psk-fldigi ./decoders/psk-fldigi
RUN mkdir -p /out && bash decoders/psk-fldigi/build.sh && cp decoders/psk-fldigi/bin/psk-fldigi-decoder /out/psk-fldigi-decoder

# ---- rtty-fldigi decoder native build (vendored fldigi RX path) ----
FROM debian:bookworm-slim AS rtty-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/rtty-fldigi ./decoders/rtty-fldigi
RUN mkdir -p /out && bash decoders/rtty-fldigi/build.sh && cp decoders/rtty-fldigi/bin/rtty-fldigi-decoder /out/rtty-fldigi-decoder

# ---- contestia-fldigi decoder native build (vendored fldigi RX path) ----
FROM debian:bookworm-slim AS contestia-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/contestia-fldigi ./decoders/contestia-fldigi
RUN mkdir -p /out && bash decoders/contestia-fldigi/build.sh && cp decoders/contestia-fldigi/bin/contestia-fldigi-decoder /out/contestia-fldigi-decoder

# ---- wwv-fldigi decoder native build (vendored fldigi WWV scope) ----
FROM debian:bookworm-slim AS wwv-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends g++ libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/wwv-fldigi ./decoders/wwv-fldigi
RUN mkdir -p /out && bash decoders/wwv-fldigi/build.sh && cp decoders/wwv-fldigi/bin/wwv-fldigi-decoder /out/wwv-fldigi-decoder

# ---- RSID auto-classifier (vendored fldigi RX path + libsamplerate) ----
FROM debian:bookworm-slim AS rsid-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ libc6-dev libsamplerate0-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/rsid ./decoders/rsid
RUN mkdir -p /out && bash decoders/rsid/build.sh && cp decoders/rsid/bin/rsid-decoder /out/rsid-decoder

# ---- WSPR decoder (wsprd from wsjt-x source, no Qt) ----
# Builds only `wsprd` — a 30 KB Fortran/C binary that decodes a 2-minute
# WSPR-2 segment from a 12 kHz int16 WAV file. Uses gfortran + libfftw3.
FROM debian:bookworm-slim AS wspr-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc gfortran libfftw3-dev git ca-certificates make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/wspr ./decoders/wspr
RUN mkdir -p /out && bash decoders/wspr/build.sh && cp decoders/wspr/bin/wsprd /out/wsprd

# ---- JS8Call decoder (`js8` from js8call source, no Qt GUI) ----
# JS8 is FT8's keyboard-QSO cousin. Same Fortran-heavy build chain as
# wsprd; we build only the standalone `js8` decoder target.
FROM debian:bookworm-slim AS js8-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ gfortran libfftw3-dev cmake git ca-certificates make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/js8 ./decoders/js8
RUN mkdir -p /out && bash decoders/js8/build.sh && cp decoders/js8/bin/js8 /out/js8 || \
    (echo "JS8 build failed; runtime panel will report missing binary." >&2 && touch /out/js8)

# ---- FST4 / FST4W decoder (`fst4d` from wsjt-x source) ----
# WSJT-X weak-signal modes for LF/MF DX. Same build chain as wsprd
# (gfortran + libfftw3); standalone target.
FROM debian:bookworm-slim AS fst4-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc gfortran libfftw3-dev cmake git ca-certificates make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/fst4 ./decoders/fst4
RUN mkdir -p /out && bash decoders/fst4/build.sh && cp decoders/fst4/bin/fst4d /out/fst4d || \
    (echo "FST4 build failed; runtime panel will report missing binary." >&2 && touch /out/fst4d)

# ---- JT9 / JT65 / Q65 / JT4 decoder (`jt9` from wsjt-x source) ----
# All four modes share the single `jt9` binary; the radiom bridges
# spawn it with -9 / -65 / -q / -4 to select the mode.
FROM debian:bookworm-slim AS jt9-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc gfortran libc6-dev libfftw3-dev cmake git ca-certificates make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/jt9 ./decoders/jt9
RUN mkdir -p /out && \
    (bash decoders/jt9/build.sh && cp decoders/jt9/bin/jt9 /out/jt9) || \
    (echo "JT9 build failed; runtime panel will report missing binary." >&2 && touch /out/jt9)

# ---- multimon-ng (EliasOenal/multimon-ng) ----
# Used for SELCAL; same binary also handles POCSAG / FLEX / EAS /
# ZVEI / DTMF / FMSFSK if/when those bridges get added.
FROM debian:bookworm-slim AS multimon-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev cmake make git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/multimon ./decoders/multimon
RUN mkdir -p /out && \
    (bash decoders/multimon/build.sh && cp decoders/multimon/bin/multimon-ng /out/multimon-ng) || \
    (echo "multimon-ng build failed; runtime panel will report missing binary." >&2 && touch /out/multimon-ng)

# ---- SSTV (slowrxd from sjlongland/slowrxd) ----
# Analog Slow-Scan-TV decoder. Headless fork of slowrx with the GUI
# replaced by JSON events + PNG-to-directory output.
FROM debian:bookworm-slim AS sstv-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev make git pkg-config ca-certificates \
        libfftw3-dev libpng-dev libsndfile1-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/sstv ./decoders/sstv
RUN mkdir -p /out && \
    (bash decoders/sstv/build.sh && cp decoders/sstv/bin/slowrxd /out/slowrxd) || \
    (echo "SSTV build failed; runtime panel will report missing binary." >&2 && touch /out/slowrxd)

# ---- FreeDV (freedv_rx from drowe67/codec2) ----
# Open-source HF digital voice. cmake build also produces libcodec2.so
# which freedv_rx links against dynamically — both files are copied
# into the runtime image.
FROM debian:bookworm-slim AS freedv-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev cmake make git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/freedv ./decoders/freedv
RUN mkdir -p /out && \
    (bash decoders/freedv/build.sh && \
     cp decoders/freedv/bin/freedv_rx /out/freedv_rx && \
     cp -P decoders/freedv/build/codec2/build_linux/src/libcodec2.so* /out/) || \
    (echo "FreeDV build failed; runtime panel will report missing binary." >&2 && \
     touch /out/freedv_rx /out/libcodec2.so.placeholder)

# ---- throb-fldigi decoder (fldigi v2 pattern) ----
FROM debian:bookworm-slim AS throb-fldigi-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ libc6-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/mfsk-fldigi ./decoders/mfsk-fldigi
COPY decoders/throb-fldigi ./decoders/throb-fldigi
RUN mkdir -p /out && bash decoders/throb-fldigi/build.sh && cp decoders/throb-fldigi/bin/throb-fldigi-decoder /out/throb-fldigi-decoder || \
    (echo "Throb build failed; runtime panel will report missing binary." >&2 && touch /out/throb-fldigi-decoder)

# ---- direwolf — HF AX.25/APRS packet decoder ----
# Built with ALSA only (no portaudio/hamlib/gpsd/cm108) so the binary's
# runtime deps stay tiny. direwolf reads raw 12 kHz int16 PCM from stdin
# via the `stdin` pseudo-device declared in decoders/packet/direwolf.conf.
FROM debian:bookworm-slim AS packet-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ make cmake git libasound2-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/packet ./decoders/packet
RUN mkdir -p /out && bash decoders/packet/build.sh && \
    cp decoders/packet/bin/direwolf /out/direwolf

# ---- runtime stage ----
# debian-slim for the apt-managed `multimon-ng` package used by the
# server-side CW decoder.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
# Runtime shared-library deps for dumphfdl (HFDL decoder).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libliquid1 libfftw3-single3 libglib2.0-0 libconfig++9v5 \
        libxml2 libsqlite3-0 zlib1g \
        libsamplerate0 \
        libasound2 \
        libgfortran5 \
        libpng16-16 libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./
COPY decoder ./decoder
COPY audio ./audio
COPY --from=build /app/dist ./dist
COPY --from=wefax-build /out/wefax-decoder ./decoders/wefax/bin/wefax-decoder
COPY --from=cw-build    /out/cw-decoder    ./decoders/cw/bin/cw-decoder
COPY --from=navtex-build /out/navtex-decoder ./decoders/navtex/bin/navtex-decoder
COPY --from=ale-2g-build /out/ale-2g-decoder ./decoders/ale-2g/bin/ale-2g-decoder
COPY --from=hfdl-build /out/dumphfdl ./decoders/hfdl/bin/dumphfdl
COPY --from=hfdl-build /out/libacars-2.so* ./decoders/hfdl/bin/
COPY --from=psk-fldigi-build /out/psk-fldigi-decoder ./decoders/psk-fldigi/bin/psk-fldigi-decoder
COPY --from=olivia-fldigi-build /out/olivia-fldigi-decoder ./decoders/olivia-fldigi/bin/olivia-fldigi-decoder
COPY --from=mfsk-fldigi-build /out/mfsk-fldigi-decoder ./decoders/mfsk-fldigi/bin/mfsk-fldigi-decoder
COPY --from=mt63-fldigi-build /out/mt63-fldigi-decoder ./decoders/mt63-fldigi/bin/mt63-fldigi-decoder
COPY --from=fsq-fldigi-build /out/fsq-fldigi-decoder ./decoders/fsq-fldigi/bin/fsq-fldigi-decoder
COPY --from=thor-fldigi-build /out/thor-fldigi-decoder ./decoders/thor-fldigi/bin/thor-fldigi-decoder
COPY --from=dominoex-fldigi-build /out/dominoex-fldigi-decoder ./decoders/dominoex-fldigi/bin/dominoex-fldigi-decoder
COPY --from=rtty-fldigi-build /out/rtty-fldigi-decoder ./decoders/rtty-fldigi/bin/rtty-fldigi-decoder
COPY --from=contestia-fldigi-build /out/contestia-fldigi-decoder ./decoders/contestia-fldigi/bin/contestia-fldigi-decoder
COPY --from=wwv-fldigi-build /out/wwv-fldigi-decoder ./decoders/wwv-fldigi/bin/wwv-fldigi-decoder
COPY --from=rsid-build /out/rsid-decoder ./decoders/rsid/bin/rsid-decoder
COPY --from=packet-build /out/direwolf ./decoders/packet/bin/direwolf
COPY decoders/packet/direwolf.conf ./decoders/packet/direwolf.conf
COPY --from=wspr-build /out/wsprd ./decoders/wspr/bin/wsprd
COPY --from=js8-build  /out/js8   ./decoders/js8/bin/js8
COPY --from=fst4-build /out/fst4d ./decoders/fst4/bin/fst4d
COPY --from=jt9-build  /out/jt9   ./decoders/jt9/bin/jt9
COPY --from=multimon-build /out/multimon-ng ./decoders/multimon/bin/multimon-ng
COPY --from=sstv-build /out/slowrxd ./decoders/sstv/bin/slowrxd
COPY --from=freedv-build /out/freedv_rx ./decoders/freedv/bin/freedv_rx
COPY --from=freedv-build /out/libcodec2.so* /usr/local/lib/
COPY --from=throb-fldigi-build /out/throb-fldigi-decoder ./decoders/throb-fldigi/bin/throb-fldigi-decoder
# Refresh the dynamic-linker cache so freedv_rx finds libcodec2.so at
# runtime (the .so files live under /usr/local/lib which is on the
# default search path but only if ldconfig has registered them).
RUN ldconfig
EXPOSE 8080
CMD ["node", "server.mjs"]
