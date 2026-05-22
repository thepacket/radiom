#!/usr/bin/env bash
# Build the FST4/FST4W decoder (`fst4d`) from wsjt-x source.
#
# FST4 / FST4W are the WSJT-X weak-signal modes added for LF/MF (2200m,
# 630m) DX in 2020. fst4d reads a 12 kHz mono int16 WAV file containing
# a single submode period (60/120/300/900/1800 s) and emits decoded
# message lines on stdout. Same Fortran-heavy build chain as wsprd.
#
# Build deps:  gcc, gfortran, libfftw3-dev (single-precision)
# Runtime deps: libfftw3-single3
#
# Output: decoders/fst4/bin/fst4d
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/fst4"
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
      git clone --depth 1 --branch "$WSJTX_REF" \
        https://git.code.sf.net/p/wsjt/wsjtx wsjtx
    fi
    # The fst4 sources live under lib/fst4; build the standalone fst4d
    # target. We share the wsprd-style approach: compile only what we
    # need without the Qt GUI.
    cd wsjtx
    if [ -f lib/fst4/Makefile ]; then
      cd lib/fst4
      make fst4d
      cp fst4d "$OUT/fst4d"
    else
      # Newer wsjtx layouts only build via cmake.
      mkdir -p build && cd build
      cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null
      make fst4d
      [ -f fst4d ] && cp fst4d "$OUT/fst4d" || cp lib/fst4d "$OUT/fst4d"
    fi
    echo "✓ Built decoders/fst4/bin/fst4d"
    ;;
  Darwin)
    if ! command -v gfortran >/dev/null; then
      echo "Install gfortran first: brew install gcc" >&2
      echo "(Skipping local build — Linux Docker stage will produce the runtime binary.)" >&2
      exit 0
    fi
    cd "$WORK"
    if [ ! -d wsjtx ]; then
      git clone --depth 1 --branch "$WSJTX_REF" \
        https://git.code.sf.net/p/wsjt/wsjtx wsjtx
    fi
    cd wsjtx
    BREW_FFTW="$(brew --prefix fftw 2>/dev/null || echo '')"
    if [ -f lib/fst4/Makefile ]; then
      cd lib/fst4
      if [ -n "$BREW_FFTW" ]; then
        CFLAGS="-I$BREW_FFTW/include -O3" LDFLAGS="-L$BREW_FFTW/lib" make fst4d
      else
        make fst4d
      fi
      cp fst4d "$OUT/fst4d"
      echo "✓ Built decoders/fst4/bin/fst4d"
    else
      echo "(fst4 build path differs in this wsjtx revision; the Linux Docker stage handles it.)" >&2
    fi
    ;;
  *) echo "unsupported host $UNAME" >&2; exit 1;;
esac
