#!/usr/bin/env bash
# Build hessu/aisdecoder — version-controlled mirror of aishub.net's
# aisdecoder (the gnuais audio demodulator/decoder for AIS). Pure C,
# reads 48 kHz int16 mono PCM via `-a file -f <path>`, emits NMEA-0183
# !AIVDM sentences over UDP.
#
# Previous attempt used dgiardini/rtl-ais which has no standalone audio
# binary (only rtl_ais, which needs RTL-SDR hardware). The `aisdecoder/`
# subdir in that project contains source files that get linked into
# rtl_ais, not a separate executable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/ais"
OUT="$SRC/bin"
WORK="$SRC/build"
AIS_REF="${AIS_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc make git cmake; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d aisdecoder ]; then
      git clone --depth 1 --branch "$AIS_REF" https://github.com/hessu/aisdecoder.git aisdecoder
    fi
    cd aisdecoder
    mkdir -p build && cd build
    # CMakeLists hard-fails on Linux without ALSA or PulseAudio headers,
    # even though we only use the `file` audio driver. libasound2-dev
    # is the lighter dep — pull it in via the Dockerfile stage.
    cmake -DCMAKE_BUILD_TYPE=Release ..
    make -j "$(nproc 2>/dev/null || echo 2)"
    if [ ! -x aisdecoder ]; then
      echo "aisdecoder build produced no binary; build tree:" >&2
      ls -la >&2
      exit 1
    fi
    cp aisdecoder "$OUT/aisdecoder"
    echo "✓ Built decoders/ais/bin/aisdecoder (hessu/aisdecoder)"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds aisdecoder.)" >&2
    ;;
esac
