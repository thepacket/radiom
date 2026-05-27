#!/usr/bin/env bash
# Build acarsdec (TLeconte/acarsdec) — ACARS VHF decoder.
# 131 MHz airline data link, MSK 2400 bps. The audio-only variant
# (no SDR driver) takes int16 LE 12500 Hz from stdin and prints
# decoded messages on stdout (JSON when -J is set).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/acars"
OUT="$SRC/bin"
WORK="$SRC/build"
ACARS_REF="${ACARS_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc make git cmake; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    # Use f00b4r0/acarsdec — fork with native stdin support via
    # `--sndfile file=/dev/stdin,subtype=0x02`. TLeconte's upstream
    # doesn't have stdin streaming (libsndfile tries to seek the
    # header), so we vendor the streaming-capable fork.
    if [ ! -d acarsdec ]; then
      git clone --depth 1 --branch "$ACARS_REF" https://github.com/f00b4r0/acarsdec.git acarsdec
    fi
    cd acarsdec
    # Diagnostics: confirm libacars actually got installed into this
    # stage. We've hit a class of bugs where pkg-config reports the lib
    # but the headers landed in a different prefix (e.g. multiarch
    # libdir, or tarball stripped them). Print the paths cmake will see.
    echo "--- libacars install inspection ---" >&2
    pkg-config --cflags libacars-2 >&2 || echo "pkg-config: libacars-2 not found" >&2
    pkg-config --libs libacars-2 >&2 || true
    pkg-config --variable=includedir libacars-2 >&2 || true
    ls -la /usr/local/include/libacars-2/libacars/ 2>&1 | head -20 >&2 || \
      echo "  /usr/local/include/libacars-2/libacars/ MISSING" >&2
    find /usr -name "libacars.h" 2>/dev/null >&2 || true
    echo "-----------------------------------" >&2
    mkdir -p build && cd build
    # f00b4r0 fork's cmake option names (different from TLeconte's):
    #   SNDFILE  (libsndfile, for stdin/file input)            — needed
    #   LIBACARS (sub-protocol expansion)                       — needed
    #   CJSON    (JSON output, default ON)                      — needed
    #   ALSA     (alsa-direct, default ON)                      — off (no audio device in container)
    #   RTLSDR / AIRSPY / SDRPLAY / SOAPYSDR                    — off (bridge feeds stdin)
    #   MQTT     (paho client, only if CJSON)                   — default off
    # MQTT is auto-disabled when CJSON=OFF, but it defaults ON when CJSON
    # is ON. We don't ship paho-mqtt3a in the runtime image, so force it
    # off explicitly to avoid pulling libpaho-mqtt-dev into the build.
    cmake -DCMAKE_BUILD_TYPE=Release \
          -DSNDFILE=ON -DLIBACARS=ON -DCJSON=ON -DMQTT=OFF \
          -DALSA=OFF \
          -DRTLSDR=OFF -DAIRSPY=OFF -DSDRPLAY=OFF -DSOAPYSDR=OFF \
          ..
    make -j "$(nproc 2>/dev/null || echo 2)"
    if [ ! -x acarsdec ]; then
      echo "acarsdec build did not produce a binary" >&2
      ls -la >&2 || true
      exit 1
    fi
    cp acarsdec "$OUT/acarsdec"
    echo "✓ Built decoders/acars/bin/acarsdec (f00b4r0 fork)"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds acarsdec.)" >&2
    ;;
esac
