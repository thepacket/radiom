#!/usr/bin/env bash
# Build msk144d from the wsjt-x source tree. MSK144 is the WSJT-X
# meteor-scatter mode: 144 baud MSK, 15 s T/R period, 72 ms message
# repeats. The msk144d binary processes a 15 s mono 12 kHz int16 WAV
# and prints decoded message lines on stdout. Same Fortran build chain
# as jt9 / fst4d / wsprd — reuses the wsjtx clone the other stages
# already make.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/msk144"
OUT="$SRC/bin"
WORK="$SRC/build"
WSJTX_REF="${WSJTX_REF:-master}"

mkdir -p "$OUT" "$WORK"

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gfortran gcc git make; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d wsjtx ]; then
      git clone --depth 1 --branch "$WSJTX_REF" https://git.code.sf.net/p/wsjt/wsjtx wsjtx
    fi
    cd wsjtx
    if [ -f lib/Makefile ]; then
      cd lib
      make msk144d
      cp msk144d "$OUT/msk144d"
    else
      mkdir -p build && cd build
      cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null
      make msk144d
      [ -f msk144d ] && cp msk144d "$OUT/msk144d" || cp lib/msk144d "$OUT/msk144d"
    fi
    echo "✓ Built decoders/msk144/bin/msk144d"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds msk144d.)" >&2
    ;;
esac
