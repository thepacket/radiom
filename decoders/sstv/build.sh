#!/usr/bin/env bash
# Build the SSTV decoder (`slowrxd`) from sjlongland/slowrxd — a
# headless fork of windytan/slowrx that drops the GTK GUI and adds
# JSON event output, perfect for a server-side bridge.
#
# slowrxd supports the standard analog SSTV modes: Robot 36/72,
# Scottie S1/S2/DX, Martin M1/M2/M3/M4, Pasokon P3/P5/P7, PD modes
# (PD50/PD90/PD120/PD160/PD180/PD240), Wraase SC2, AVT 90, etc.
#
# Build deps:  gcc, make, libfftw3-single-dev, libpng-dev, libsndfile1-dev
# Runtime deps: libfftw3-single3, libpng16, libsndfile1
#
# Output: decoders/sstv/bin/slowrxd
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/sstv"
OUT="$SRC/bin"
WORK="$SRC/build"
SLOWRX_REF="${SLOWRX_REF:-master}"

mkdir -p "$OUT" "$WORK"

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc git make pkg-config; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d slowrxd ]; then
      git clone --depth 1 --branch "$SLOWRX_REF" \
        https://github.com/sjlongland/slowrxd.git slowrxd
    fi
    cd slowrxd
    # slowrxd ships a top-level Makefile; build the daemon binary.
    make
    if [ -f slowrxd ]; then
      cp slowrxd "$OUT/slowrxd"
    elif [ -f build/slowrxd ]; then
      cp build/slowrxd "$OUT/slowrxd"
    else
      echo "slowrxd binary not found after build" >&2
      exit 1
    fi
    echo "✓ Built decoders/sstv/bin/slowrxd"
    ;;
  Darwin)
    cd "$WORK"
    if [ ! -d slowrxd ]; then
      git clone --depth 1 --branch "$SLOWRX_REF" \
        https://github.com/sjlongland/slowrxd.git slowrxd
    fi
    cd slowrxd
    # slowrxd depends on fftw / libpng / libsndfile via pkg-config.
    BREW_PREFIXES=""
    for pkg in fftw libpng libsndfile; do
      p=$(brew --prefix "$pkg" 2>/dev/null || echo "")
      [ -n "$p" ] && BREW_PREFIXES="${BREW_PREFIXES}:${p}/lib/pkgconfig"
    done
    PKG_CONFIG_PATH="${BREW_PREFIXES#:}:${PKG_CONFIG_PATH:-}" make || {
      echo "(macOS build may need extra patches; Linux Docker stage handles it.)" >&2
      exit 0
    }
    cp slowrxd "$OUT/slowrxd" 2>/dev/null || true
    [ -f "$OUT/slowrxd" ] && echo "✓ Built decoders/sstv/bin/slowrxd"
    ;;
  *) echo "unsupported host $UNAME" >&2; exit 1;;
esac
