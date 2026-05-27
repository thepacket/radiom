#!/usr/bin/env bash
# Build dsd-fme — Digital Speech Decoder, Florida Man Edition
# (lwvmobile/dsd-fme). Decodes the narrowband VHF/UHF digital-voice
# protocols (DMR / D-STAR / NXDN / YSF / dPMR / M17 / P25 / X2-TDMA).
#
# Verified against the project's Install_Notes.md (audio_work branch).
# Two key constraints:
#   1. Default branch is `audio_work`, not `main`.
#   2. dsd-fme has no stdin audio mode — input is either `-i file.wav`
#      or `-i tcp` (the bridge in decoder/dsd.mjs uses the TCP path,
#      which means the bridge opens a localhost TCP listener and
#      dsd-fme connects as a client).
#
# mbelib (Mike's Audio Codec Library) is a build-time dep that
# dsd-fme links against for AMBE/IMBE voice decode. We vendor it
# locally so a stale Debian package never breaks the build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/dsd"
OUT="$SRC/bin"
WORK="$SRC/build"
DSD_REF="${DSD_REF:-audio_work}"        # ← active dev branch
MBELIB_REF="${MBELIB_REF:-master}"

mkdir -p "$OUT" "$WORK"

build_mbelib() {
  cd "$WORK"
  if [ ! -d mbelib ]; then
    git clone --depth 1 --branch "$MBELIB_REF" \
      https://github.com/szechyjs/mbelib.git mbelib
  fi
  cd mbelib
  mkdir -p build && cd build
  cmake -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$WORK/mbelib-install" .. >/dev/null
  make -j install
}

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc g++ cmake make git; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    build_mbelib
    cd "$WORK"
    if [ ! -d dsd-fme ]; then
      git clone --depth 1 --branch "$DSD_REF" \
        https://github.com/lwvmobile/dsd-fme.git dsd-fme
    fi
    cd dsd-fme
    mkdir -p build && cd build
    # Point cmake at the locally-built mbelib install prefix.
    cmake -DCMAKE_BUILD_TYPE=Release \
          -DCMAKE_PREFIX_PATH="$WORK/mbelib-install" \
          -DMBE_INCLUDE_DIR="$WORK/mbelib-install/include" \
          -DMBE_LIBRARY="$WORK/mbelib-install/lib/libmbe.a" \
          .. >/dev/null
    make -j "$(nproc 2>/dev/null || echo 2)" dsd-fme
    cp dsd-fme "$OUT/dsd-fme"
    echo "✓ Built decoders/dsd/bin/dsd-fme (branch=$DSD_REF)"
    ;;
  Darwin)
    if ! command -v cmake >/dev/null; then
      echo "Install cmake first: brew install cmake" >&2
      exit 0
    fi
    echo "(macOS — Linux Docker stage builds dsd-fme.)" >&2
    ;;
  *) echo "unsupported host $UNAME" >&2; exit 1;;
esac
