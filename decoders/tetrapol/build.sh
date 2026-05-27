#!/usr/bin/env bash
# Build tetrapol-kit (sysmocom/tetrapol-kit) — French/EU public-safety
# digital voice + control channel. 380–400 MHz, GMSK 8000 bps.
#
# tetrapol-kit is Python + a few native helpers. We build the
# `tetrapol_dump` CLI which takes 80 kHz int16 from stdin and prints
# decoded frames on stdout (text + base64 voice).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/tetrapol"
OUT="$SRC/bin"
WORK="$SRC/build"
TETRAPOL_REF="${TETRAPOL_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc make git cmake python3; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d tetrapol-kit ]; then
      git clone --depth 1 --branch "$TETRAPOL_REF" https://github.com/sysmocom/tetrapol-kit.git tetrapol-kit
    fi
    cd tetrapol-kit
    mkdir -p build && cd build
    cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null
    make
    # Try the most common binary names — tetrapol-kit's CLI has shifted.
    for cand in tetrapol_dump tetrapol_demod tetrapol-cli; do
      [ -f "$cand" ] && cp "$cand" "$OUT/tetrapol" && break
    done
    [ -f "$OUT/tetrapol" ] && echo "✓ Built decoders/tetrapol/bin/tetrapol"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds tetrapol.)" >&2
    ;;
esac
