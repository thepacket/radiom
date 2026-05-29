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

# ---- DSD-FME (lwvmobile/dsd-fme + mbelib) ----
# Single binary covering D-STAR / DMR / NXDN / YSF / dPMR / M17 /
# P25-P1 / P25-P2 / X2-TDMA. mbelib provides the IMBE/AMBE voice
# codec. Branch pinned to audio_work (the active upstream dev branch
# as of 2026; default branch on the lwvmobile fork).
#
# Apt deps verified against the project's Install_Notes.md:
#   libpulse-dev libsndfile1-dev libfftw3-dev liblapack-dev
#   libusb-1.0-0-dev libncurses5-dev librtlsdr-dev libcodec2-dev
# We install all of them — even ones the bridge doesn't strictly
# need (libpulse, librtlsdr) since cmake conditionally enables
# features based on their presence and a partial build sometimes
# fails late in the linker.
FROM debian:bookworm-slim AS dsd-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ gcc libc6-dev cmake make git pkg-config ca-certificates \
        build-essential \
        libpulse-dev libsndfile1-dev libfftw3-dev liblapack-dev \
        libusb-1.0-0-dev libncurses5-dev librtlsdr-dev libcodec2-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/dsd ./decoders/dsd
RUN mkdir -p /out && \
    (bash decoders/dsd/build.sh && cp decoders/dsd/bin/dsd-fme /out/dsd-fme) || \
    (echo "DSD build failed; DSD modes will report missing binary at runtime." >&2 && touch /out/dsd-fme)

# ---- MSK144 (wsjt-x msk144d) ----
FROM debian:bookworm-slim AS msk144-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc gfortran libc6-dev libfftw3-dev cmake git ca-certificates make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/msk144 ./decoders/msk144
RUN mkdir -p /out && \
    (bash decoders/msk144/build.sh && cp decoders/msk144/bin/msk144d /out/msk144d) || \
    (echo "msk144d build failed." >&2 && touch /out/msk144d)

# ---- DSC (jbirby/DSC-Codec) ----
# Pure-Python ITU-R M.493 decoder. We don't need a separate build
# stage — the bridge invokes `python3 dsc_decode.py <wav>` at runtime,
# so it suffices to stage the scripts under /out and `apt install
# python3 python3-numpy` in the runtime image.
FROM debian:bookworm-slim AS dsc-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/dsc ./decoders/dsc
RUN mkdir -p /out && \
    bash decoders/dsc/build.sh && \
    cp -r decoders/dsc/bin/. /out/

# ---- AIS (hessu/aisdecoder — version-controlled aishub.net build) ----
# Audio-in / NMEA-out AIS demodulator from the gnuais lineage. cmake
# hard-fails on Linux unless ALSA or PulseAudio headers are present,
# so we install libasound2-dev even though only the `file` driver is
# used at runtime.
FROM debian:bookworm-slim AS ais-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ libc6-dev make git ca-certificates pkg-config cmake \
        libasound2-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/ais ./decoders/ais
RUN mkdir -p /out && \
    bash decoders/ais/build.sh && \
    cp decoders/ais/bin/aisdecoder /out/aisdecoder && \
    { /out/aisdecoder -H 2>&1 | head -5 || true; }

# ---- libacars (szpajder/libacars) ----
# Shared dependency for ACARS-payload sub-protocol expansion (CPDLC,
# ADS-C, MIAM, OHMA, …). Built once here and consumed by both the
# ACARS and VDL-2 stages.
FROM debian:bookworm-slim AS libacars-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev make git ca-certificates cmake libxml2-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN set -e; \
    git clone --depth 1 https://github.com/szpajder/libacars.git libacars && \
    cd libacars && mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
          -DCMAKE_INSTALL_LIBDIR=lib .. && \
    make -j"$(nproc)" install && ldconfig && \
    echo "--- libacars install inspection ---" && \
    find /usr/local -name "libacars*" -o -name "libacars-2.pc" 2>/dev/null | sort && \
    test -f /usr/local/include/libacars-2/libacars/libacars.h || { \
      echo "ERROR: libacars headers not at expected path" >&2; \
      find / -name "libacars.h" 2>/dev/null; exit 1; \
    } && \
    test -f /usr/local/lib/pkgconfig/libacars-2.pc || { \
      echo "ERROR: libacars-2.pc not installed" >&2; exit 1; \
    } && \
    tar czf /libacars-install.tar.gz \
        -C / usr/local/include/libacars-2 \
        $(cd / && ls usr/local/lib/libacars-2.so* 2>/dev/null) \
        usr/local/lib/pkgconfig/libacars-2.pc && \
    echo "--- tarball contents ---" && \
    tar tzf /libacars-install.tar.gz

# ---- ACARS (f00b4r0/acarsdec — fork with native stdin streaming) ----
# Build deps for the fork's CMake options that we enable:
#   SNDFILE   → libsndfile1-dev
#   LIBACARS  → libacars-2-dev (vendored from libacars-build stage)
#   CJSON     → libcjson-dev
# Disabled options (ALSA, RTLSDR, SOAPYSDR, AIRSPY, SDRPLAY) save us
# their dev packages.
FROM debian:bookworm-slim AS acars-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev make git ca-certificates cmake pkg-config \
        libsndfile1-dev libcjson-dev libxml2-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
# Drop libacars into /usr/local before the main build so acarsdec's
# cmake finds it and turns on CPDLC / ADS-C / MIAM expansion.
COPY --from=libacars-build /libacars-install.tar.gz /tmp/
RUN tar xzf /tmp/libacars-install.tar.gz -C / && ldconfig
WORKDIR /src
COPY decoders/acars ./decoders/acars
RUN mkdir -p /out && \
    bash decoders/acars/build.sh && \
    cp decoders/acars/bin/acarsdec /out/acarsdec && \
    { /out/acarsdec --help 2>&1 | head -3 || true; }

# TETRAPOL build stage retired: the original upstream
# (sysmocom/tetrapol-kit) doesn't exist; the maintained fork is
# airphel/tetrapol-kit-2023 but its tetrapol_dump binary expects
# pre-demodulated bits, not audio. A working pipeline needs the
# upstream Python+GNURadio demodulator, which we don't ship.

# ---- OP25 (boatbod/op25 — actively maintained P25 trunking decoder) ----
# GNU Radio 3.10-based (Bookworm ships 3.10). dev libs follow boatbod's
# install.sh dep list, minus the items we don't need (clang-format,
# doxygen for docs, gnuplot for plot subcommand, uhd for USRP — we
# feed IQ from our own bridge, no UHD hardware).
FROM debian:bookworm-slim AS op25-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ libc6-dev make git ca-certificates cmake pkg-config \
        gnuradio gnuradio-dev gr-osmosdr \
        librtlsdr-dev libhackrf-dev liborc-0.4-dev \
        libsndfile1-dev libspdlog-dev \
        libboost-all-dev libfftw3-dev \
        python3 python3-dev python3-pybind11 \
        python3-numpy python3-waitress python3-requests \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/op25 ./decoders/op25
RUN mkdir -p /out && \
    bash decoders/op25/build.sh && \
    cp decoders/op25/bin/op25-decode /out/op25-decode && \
    cp decoders/op25/bin/op25-apps.tar.gz /out/op25-apps.tar.gz && \
    # Capture the gr-op25 C++ extensions that `make install` placed
    # under /usr/local/{lib,include}/op25* for the runtime image.
    tar czf /out/op25-install.tar.gz -C / \
        $(find /usr/local/lib /usr/local/include -maxdepth 5 \
              -name "*op25*" 2>/dev/null | sed 's|^/||') \
        2>/dev/null || true

# ---- LRPT / satdump — DISABLED for faster deploys ----
# The satdump build is the slowest stage (~5–10 min): full upstream
# clone + cmake build of every plugin + a TLE pre-seed RUN. To re-
# enable, uncomment the block below AND the matching COPY/RUN block
# under the runtime stage further down. The LRPT decoder button in
# the UI will fail silently (no satdump binary on PATH) until then.
#
# FROM debian:bookworm-slim AS lrpt-build
# RUN apt-get update && apt-get install -y --no-install-recommends \
#         gcc g++ libc6-dev make git ca-certificates cmake pkgconf \
#         libfftw3-dev libpng-dev libjpeg-dev libtiff-dev \
#         libsqlite3-dev libvolk2-dev libnng-dev libjemalloc-dev \
#         zlib1g-dev libcurl4-openssl-dev \
#     && rm -rf /var/lib/apt/lists/*
# WORKDIR /src
# COPY decoders/lrpt ./decoders/lrpt
# RUN mkdir -p /out && \
#     bash decoders/lrpt/build.sh && \
#     cp decoders/lrpt/bin/satdump-install.tar.gz /out/satdump-install.tar.gz && \
#     { /usr/local/bin/satdump --help 2>&1 | head -5 || true; }
# RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
#     mkdir -p /out/tle-seed/usr/local/share/satdump && \
#     curl -fsSL -A 'Mozilla/5.0 (X11; Linux x86_64)' \
#          'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle' \
#          -o /out/tle-seed/usr/local/share/satdump/initial_tles.tle \
#       || (echo "WARN: TLE pre-seed download failed; runtime will retry against celestrak" >&2 && \
#           : > /out/tle-seed/usr/local/share/satdump/initial_tles.tle)

# ---- ADS-B (flightaware/dump1090) ----
# Active fork (formerly mutability/dump1090, last touched 2017).
# Makefile build, no cmake. Deps verified against the upstream
# debian/control: build-essential, librtlsdr-dev, libncurses5-dev,
# libbladerf-dev / libhackrf-dev / liblimesuite-dev / libsoapysdr-dev
# are required for SDR backends but optional — the binary builds
# without them. The bridge uses --ifile/stdin (no SDR backend needed).
FROM debian:bookworm-slim AS adsb-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libc6-dev make git ca-certificates pkg-config \
        librtlsdr-dev libncurses5-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/adsb ./decoders/adsb
RUN mkdir -p /out && \
    (bash decoders/adsb/build.sh && cp decoders/adsb/bin/dump1090 /out/dump1090) || \
    (echo "dump1090 build failed." >&2 && touch /out/dump1090)

# ---- VDL-2 (szpajder/dumpvdl2) ----
FROM debian:bookworm-slim AS vdl2-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ libc6-dev make git ca-certificates cmake pkg-config \
        libglib2.0-dev libxml2-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
# libacars provides ACARS-over-VDL-2 payload expansion (CPDLC,
# ADS-C, MIAM, OHMA). Without it dumpvdl2 just prints raw blobs.
COPY --from=libacars-build /libacars-install.tar.gz /tmp/
RUN tar xzf /tmp/libacars-install.tar.gz -C / && ldconfig
WORKDIR /src
COPY decoders/vdl2 ./decoders/vdl2
RUN mkdir -p /out && \
    bash decoders/vdl2/build.sh && \
    cp decoders/vdl2/bin/dumpvdl2 /out/dumpvdl2 && \
    { /out/dumpvdl2 --help 2>&1 | head -5 || true; }

# ---- UAT 978 MHz (flightaware/dump978-fa) ----
# Org-rename + active fork: mutability/dump978 was archived in 2026;
# flightaware/dump978 is the live successor (same lineage as our
# dump1090-fa). C++ build needs Boost + SoapySDR dev headers even
# when only the stdin-input mode is used.
FROM debian:bookworm-slim AS uat-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ libc6-dev make git ca-certificates pkg-config \
        libboost-program-options-dev libboost-regex-dev \
        libboost-filesystem-dev libboost-system-dev \
        libsoapysdr-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/uat ./decoders/uat
RUN mkdir -p /out && \
    bash decoders/uat/build.sh && \
    cp decoders/uat/bin/dump978 /out/dump978 && \
    { /out/dump978 --help 2>&1 | head -5 || true; }

# WMBus build stage retired: wmbusmeters is a frame parser, not an
# IQ demodulator — radiom's wire shape (raw IQ) doesn't match what it
# expects. Decoding wmbus traffic in radiom is done via the rtl_433
# button at 868.300 MHz, which handles the IQ→telegram demod natively.

# ---- RDS (windytan/redsea — Rust) ----
FROM debian:bookworm-slim AS rds-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        cargo rustc git ca-certificates pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/rds ./decoders/rds
RUN mkdir -p /out && \
    (bash decoders/rds/build.sh && cp decoders/rds/bin/redsea /out/redsea) || \
    (echo "redsea build failed." >&2 && touch /out/redsea)

# ---- JAERO (jontio/JAERO headless CLI) — Inmarsat AERO Classic ----
FROM debian:bookworm-slim AS jaero-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ libc6-dev make git ca-certificates cmake pkg-config \
        libxml2-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
# libacars-2 enables ARINC-622 / ADS-C / CPDLC payload expansion in the
# AERO decoder; without it the JSON output just shows the outer ACARS
# envelope. Reuse the libacars-build stage so we don't build it twice.
COPY --from=libacars-build /libacars-install.tar.gz /tmp/
RUN tar xzf /tmp/libacars-install.tar.gz -C / && ldconfig
WORKDIR /src
COPY decoders/jaero ./decoders/jaero
RUN mkdir -p /out && \
    bash decoders/jaero/build.sh && \
    cp decoders/jaero/bin/jaero-cli /out/jaero-cli && \
    { /out/jaero-cli --help 2>&1 | head -10 || true; }

# ---- Cospas-Sarsat 406 MHz ELT/EPIRB (jbirby/COSPAS-SARSAT-…-Codec) ----
# Python decoder for 1G/2G distress beacons (C/S T.001 / T.018). MIT
# licensed. Reuses python3+numpy from the DSC runtime layer; no
# GNU Radio, no compiled bits — just stages the scripts.
FROM debian:bookworm-slim AS cospas-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/cospas ./decoders/cospas
RUN mkdir -p /out && \
    bash decoders/cospas/build.sh && \
    cp -r decoders/cospas/bin/. /out/

# Inmarsat STD-C build stage retired: sigsegv-mvm/scytale-c is gone
# (404). The decoder is now routed through alphafox02/inmarsat-sniffer
# (the same binary the jaero-build stage produces) with --mode=stdc.
# No separate stdc binary needed — the runtime image carries one
# inmarsat-sniffer copy under decoders/jaero/bin/jaero-cli, used by
# both the JAERO and STD-C bridges.

# ---- rtl_433 (merbanan/rtl_433) — ISM-band protocol zoo ----
FROM debian:bookworm-slim AS rtl433-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ libc6-dev make git ca-certificates cmake pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/rtl433 ./decoders/rtl433
RUN mkdir -p /out && \
    bash decoders/rtl433/build.sh && \
    cp decoders/rtl433/bin/rtl_433 /out/rtl_433 && \
    { /out/rtl_433 -h 2>&1 | head -3 || true; }

# ---- Radiosonde (rs1729/RS) — RS41 / DFM / M10 weather balloons ----
FROM debian:bookworm-slim AS sonde-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc libc6-dev make git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/sonde ./decoders/sonde
RUN mkdir -p /out && \
    bash decoders/sonde/build.sh && \
    cp -r decoders/sonde/bin/. /out/ && \
    { /out/rs41mod -h 2>&1 | head -3 || true; }

# ---- LoRa (tapparelj/gr-lora_sdr) — chirp-spread-spectrum IoT ----
# GNU Radio 3.10 OOT module. Same toolchain the OP25 stage uses;
# pybind11 + numpy are the Python-binding layer for the C++ blocks.
FROM debian:bookworm-slim AS lora-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ libc6-dev make git ca-certificates cmake pkg-config \
        gnuradio gnuradio-dev gr-osmosdr \
        liborc-0.4-dev \
        libsndfile1-dev libspdlog-dev \
        libboost-all-dev libfftw3-dev \
        python3 python3-dev python3-pybind11 \
        python3-numpy \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/lora ./decoders/lora
RUN mkdir -p /out && \
    bash decoders/lora/build.sh && \
    cp -r decoders/lora/bin/. /out/ && \
    { /out/lora-decode --help 2>&1 | head -5 || true; }

# ---- LTR (MattCheramie/GopherTrunk) — pure-Go trunked-radio scanner ----
# Builds a single static binary; Go toolchain only, no GR dep.
FROM debian:bookworm-slim AS ltr-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        golang-go git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/ltr ./decoders/ltr
RUN mkdir -p /out && \
    (bash decoders/ltr/build.sh && cp decoders/ltr/bin/gophertrunk /out/gophertrunk) || \
    (echo "GopherTrunk build failed; LTR panel will report missing binary." >&2 && touch /out/gophertrunk)

# Timesig build stage retired: dokutan/dcf77-decode takes pre-decoded
# bit lines, not audio. The AM-envelope+pulse-width demod layer that
# would turn LF audio into bits doesn't exist in radiom. Use the
# btnTimeStations frequency picker for manual time-station listening.

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
RUN mkdir -p /out && \
    bash decoders/throb-fldigi/build.sh && \
    cp decoders/throb-fldigi/bin/throb-fldigi-decoder /out/throb-fldigi-decoder && \
    { /out/throb-fldigi-decoder --help 2>&1 | head -3 || true; }

# ---- csdr (jketterl/csdr) — OpenWebRX DSP toolkit ----
# Used by the SpyServer bridge for server-side IQ→audio demod and
# server-side FFT/waterfall generation. Single binary with stdin/
# stdout subcommands (fmdemod_quadri_cf, amdemod_cf, bandpass_fir_fft_cc,
# fft_cc, logpower_cf, convert_f_s16, ...). Same DSP code OpenWebRX
# ships in production.
FROM debian:bookworm-slim AS csdr-build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ libc6-dev make cmake git ca-certificates pkg-config \
        binutils \
        libfftw3-dev libsamplerate0-dev libcodec2-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY decoders/csdr ./decoders/csdr
RUN mkdir -p /out && \
    bash decoders/csdr/build.sh && \
    cp decoders/csdr/bin/csdr /out/csdr && \
    cp decoders/csdr/bin/csdr-install.tar.gz /out/csdr-install.tar.gz && \
    { /out/csdr 2>&1 | head -10 || true; }

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
        libpulse0 libfftw3-single3 liblapack3 libusb-1.0-0 \
        libncurses6 libncursesw6 libtinfo6 \
        librtlsdr0 libcodec2-1.0 libcjson1 \
        libtiff6 libjpeg62-turbo libcurl4 libvolk2.5 libnng1 libjemalloc2 \
        libfftw3-double3 libgomp1 \
        ca-certificates \
        python3 python3-numpy \
        # UAT runtime: dump978-fa is a Boost-program-options C++ binary.
        # libsoapysdr is linked into the binary even though we never
        # use a live SDR backend (--stdin path).
        libboost-program-options1.74.0 libboost-regex1.74.0 \
        libboost-filesystem1.74.0 libboost-system1.74.0 \
        libsoapysdr0.8 \
        # OP25 runtime: GNU Radio 3.10 + gr-osmosdr + Python deps.
        # ~150 MB of additional image size; needed for the boatbod
        # OP25 P25-trunking decoder. multi_rx.py uses waitress for its
        # HTTP terminal; requests for online TG lookups; pybind11 is
        # the binding layer for the gr-op25 C++ extensions. The
        # gr-osmosdr umbrella pulls in libgnuradio-osmosdr automatically
        # at whatever the SO-major version is on this Debian release.
        gnuradio gr-osmosdr \
        python3-pybind11 python3-waitress python3-requests \
        libspdlog1.10 \
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
COPY decoders/packet/direwolf.conf      ./decoders/packet/direwolf.conf
COPY decoders/packet/direwolf-vhf.conf  ./decoders/packet/direwolf-vhf.conf
COPY decoders/packet/direwolf-9600.conf ./decoders/packet/direwolf-9600.conf
COPY decoders/packet/direwolf-il2p.conf ./decoders/packet/direwolf-il2p.conf
COPY --from=wspr-build /out/wsprd ./decoders/wspr/bin/wsprd
COPY --from=js8-build  /out/js8   ./decoders/js8/bin/js8
COPY --from=fst4-build /out/fst4d ./decoders/fst4/bin/fst4d
COPY --from=jt9-build  /out/jt9   ./decoders/jt9/bin/jt9
COPY --from=multimon-build /out/multimon-ng ./decoders/multimon/bin/multimon-ng
# libacars shared lib used by acarsdec + dumpvdl2 at runtime for
# ACARS sub-protocol decode. Drop it directly under /usr/local/lib so
# ldconfig picks it up (already invoked below for codec2 etc.).
COPY --from=libacars-build /libacars-install.tar.gz /tmp/
RUN tar xzf /tmp/libacars-install.tar.gz -C / && rm /tmp/libacars-install.tar.gz
COPY --from=dsd-build /out/dsd-fme ./decoders/dsd/bin/dsd-fme
COPY --from=msk144-build /out/msk144d ./decoders/msk144/bin/msk144d
COPY --from=ais-build /out/aisdecoder ./decoders/ais/bin/aisdecoder
COPY --from=dsc-build /out ./decoders/dsc/bin
COPY --from=acars-build /out/acarsdec ./decoders/acars/bin/acarsdec
# tetrapol-build stage retired — no COPY needed.
COPY --from=op25-build /out/op25-decode      ./decoders/op25/bin/op25-decode
COPY --from=op25-build /out/op25-apps.tar.gz /tmp/op25-apps.tar.gz
COPY --from=op25-build /out/op25-install.tar.gz /tmp/op25-install.tar.gz
# Unpack the OP25 C++ extension libs into /usr/local (libgnuradio-op25*
# .so files + headers) and the Python apps tree into
# /usr/local/share/op25/apps (rx.py, multi_rx.py, p25_decoder.py, etc.).
RUN mkdir -p /usr/local/share/op25 && \
    tar xzf /tmp/op25-install.tar.gz -C / 2>/dev/null || true && \
    tar xzf /tmp/op25-apps.tar.gz -C /usr/local/share/op25/ && \
    rm /tmp/op25-apps.tar.gz /tmp/op25-install.tar.gz && \
    ldconfig
# satdump (LRPT) — DISABLED. Re-enable along with the lrpt-build
# stage above. Commented as a single block so it's trivial to flip
# back on when needed.
# COPY --from=lrpt-build /out/satdump-install.tar.gz /tmp/
# COPY --from=lrpt-build /out/tle-seed/usr/local/share/satdump/initial_tles.tle /usr/local/share/satdump/initial_tles.tle
# RUN tar xzf /tmp/satdump-install.tar.gz -C / && rm /tmp/satdump-install.tar.gz && ldconfig && \
#     mkdir -p ./decoders/lrpt/bin /root/.config/satdump && \
#     ln -sf /usr/local/bin/satdump ./decoders/lrpt/bin/satdump && \
#     printf '%s\n' \
#       '{' \
#       '  "tle_settings": {' \
#       '    "urls_to_fetch": [' \
#       '      "file:///usr/local/share/satdump/initial_tles.tle"' \
#       '    ],' \
#       '    "tles_to_fetch": []' \
#       '  }' \
#       '}' > /root/.config/satdump/settings.json
COPY --from=adsb-build /out/dump1090 ./decoders/adsb/bin/dump1090
COPY --from=vdl2-build /out/dumpvdl2 ./decoders/vdl2/bin/dumpvdl2
COPY --from=uat-build /out/dump978 ./decoders/uat/bin/dump978
# wmbus-build stage retired — no COPY needed.
COPY --from=rds-build /out/redsea ./decoders/rds/bin/redsea
COPY --from=jaero-build /out/jaero-cli ./decoders/jaero/bin/jaero-cli
COPY --from=cospas-build /out ./decoders/cospas/bin
# STD-C reuses the inmarsat-sniffer binary from jaero-build — no
# separate COPY. The stdc bridge references decoders/jaero/bin/jaero-cli.
COPY --from=rtl433-build /out/rtl_433 ./decoders/rtl433/bin/rtl_433
COPY --from=sonde-build /out/ ./decoders/sonde/bin/
COPY --from=lora-build /out/ ./decoders/lora/bin/
COPY --from=ltr-build /out/gophertrunk ./decoders/ltr/bin/gophertrunk
# timesig-build stage retired — no COPY needed.
COPY --from=sstv-build /out/slowrxd ./decoders/sstv/bin/slowrxd
COPY --from=freedv-build /out/freedv_rx ./decoders/freedv/bin/freedv_rx
COPY --from=freedv-build /out/libcodec2.so* /usr/local/lib/
COPY --from=throb-fldigi-build /out/throb-fldigi-decoder ./decoders/throb-fldigi/bin/throb-fldigi-decoder
# csdr (single binary + libcsdr.so for OpenWebRX-style DSP pipelines —
# used by the SpyServer bridge to demod IQ and synthesise FFT frames
# server-side, so the browser never has to do real-time DSP).
COPY --from=csdr-build /out/csdr ./decoders/csdr/bin/csdr
COPY --from=csdr-build /out/csdr-install.tar.gz /tmp/csdr-install.tar.gz
# Tarball contains usr/local/lib/libcsdr.so.<ver> + symlink. Unpack
# at / so the layout lands under /usr/local/lib (already on the linker
# search path) and refresh ld.so.cache.
RUN tar xzf /tmp/csdr-install.tar.gz -C / && \
    rm /tmp/csdr-install.tar.gz && \
    ldconfig && \
    ls -la /usr/local/lib/libcsdr* 2>&1 || true
# Refresh the dynamic-linker cache so freedv_rx finds libcodec2.so at
# runtime (the .so files live under /usr/local/lib which is on the
# default search path but only if ldconfig has registered them).
RUN ldconfig
EXPOSE 8080
CMD ["node", "server.mjs"]
