#!/usr/bin/env bash
# Build dumpvdl2 (szpajder/dumpvdl2) — VDL Mode 2 aircraft data link
# (136.7–136.95 MHz). Companion to dumphfdl which we already vendor
# for HF; same author, same build chain (autotools + libacars).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/vdl2"
OUT="$SRC/bin"
WORK="$SRC/build"
VDL2_REF="${VDL2_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc make git cmake; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d dumpvdl2 ]; then
      git clone --depth 1 --branch "$VDL2_REF" https://github.com/szpajder/dumpvdl2.git dumpvdl2
    fi
    cd dumpvdl2
    mkdir -p build && cd build
    cmake -DCMAKE_BUILD_TYPE=Release ..
    make -j "$(nproc 2>/dev/null || echo 2)" dumpvdl2
    # dumpvdl2's out-of-tree build can land the binary in either build/
    # root or build/src/ depending on version. Detect both.
    if   [ -x dumpvdl2 ];     then SRC_BIN=dumpvdl2
    elif [ -x src/dumpvdl2 ]; then SRC_BIN=src/dumpvdl2
    else
      echo "dumpvdl2 build produced no binary; build tree:" >&2
      find . -maxdepth 3 -name dumpvdl2 -type f >&2 || true
      exit 1
    fi
    cp "$SRC_BIN" "$OUT/dumpvdl2"
    chmod +x "$OUT/dumpvdl2"
    echo "✓ Built decoders/vdl2/bin/dumpvdl2 (from $SRC_BIN)"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds dumpvdl2.)" >&2
    ;;
esac
