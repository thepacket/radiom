#!/usr/bin/env bash
# Build the FreeDV decoder (`freedv_rx`) from David Rowe's codec2 repo.
#
# FreeDV is the open-source HF digital voice system: a Codec2 speech
# encoder wrapped in an OFDM modem. We build the `freedv_rx` command-
# line tool that takes 8 kHz int16 PCM of the modem audio on stdin and
# writes 8 kHz int16 PCM of decoded speech to stdout — no GUI, no
# audio devices, perfect for a server-side bridge.
#
# Modes supported by the codec2 binary:
#   1600   — Codec2 1300 bps in a 1250 Hz OFDM, the classic FreeDV mode.
#   700C   — older 700-bps mode, deprecated but still encountered.
#   700D   — modern low-SNR OFDM mode (~-4 dB usable).
#   700E   — 700D refined for fast fading.
#   2020   — LPCNet vocoder at 2020 bps OFDM, better quality at higher SNR.
#   2020B  — 2020 with tighter sync (newer codec2 builds).
#
# Build deps:  gcc, cmake, make
# Runtime deps: none (codec2 builds the binary statically against its
#               own libcodec2 / liblpcnet).
#
# Output: decoders/freedv/bin/freedv_rx
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/freedv"
OUT="$SRC/bin"
WORK="$SRC/build"
CODEC2_REF="${CODEC2_REF:-main}"

mkdir -p "$OUT" "$WORK"

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc cmake make git; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d codec2 ]; then
      git clone --depth 1 --branch "$CODEC2_REF" \
        https://github.com/drowe67/codec2.git codec2
    fi
    cd codec2
    mkdir -p build_linux && cd build_linux
    cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null
    make -j freedv_rx
    cp src/freedv_rx "$OUT/freedv_rx"
    echo "✓ Built decoders/freedv/bin/freedv_rx"
    ;;
  Darwin)
    if ! command -v cmake >/dev/null; then
      echo "Install cmake first: brew install cmake" >&2
      exit 0
    fi
    cd "$WORK"
    if [ ! -d codec2 ]; then
      git clone --depth 1 --branch "$CODEC2_REF" \
        https://github.com/drowe67/codec2.git codec2
    fi
    cd codec2
    mkdir -p build_mac && cd build_mac
    cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null || {
      echo "(macOS build needs Xcode CLT; Linux Docker stage handles it.)" >&2
      exit 0
    }
    make -j freedv_rx || true
    [ -f src/freedv_rx ] && cp src/freedv_rx "$OUT/freedv_rx" && \
      echo "✓ Built decoders/freedv/bin/freedv_rx"
    ;;
  *) echo "unsupported host $UNAME" >&2; exit 1;;
esac
