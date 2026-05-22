#!/usr/bin/env bash
# Build the JT9 decoder (`jt9`) from wsjt-x source.
#
# JT9 is the original WSJT-X weak-signal narrowband mode (1-minute UTC
# slots, 9-FSK, ~ -27 dB SNR threshold). `jt9` reads a 12 kHz mono int16
# WAV file containing a single 60-second window and emits decoded
# message lines on stdout. Same Fortran-heavy build chain as fst4d / wsprd.
#
# Build deps:  gcc, gfortran, libfftw3-dev (single-precision)
# Runtime deps: libfftw3-single3
#
# Output: decoders/jt9/bin/jt9
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/jt9"
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
    cd wsjtx
    if [ -f lib/Makefile ]; then
      cd lib
      make jt9
      cp jt9 "$OUT/jt9"
    else
      # Newer wsjtx layouts only build via cmake.
      mkdir -p build && cd build
      cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null
      make jt9
      [ -f jt9 ] && cp jt9 "$OUT/jt9" || cp lib/jt9 "$OUT/jt9"
    fi
    echo "✓ Built decoders/jt9/bin/jt9"
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
    if [ -f lib/Makefile ]; then
      cd lib
      if [ -n "$BREW_FFTW" ]; then
        CFLAGS="-I$BREW_FFTW/include -O3" LDFLAGS="-L$BREW_FFTW/lib" make jt9
      else
        make jt9
      fi
      cp jt9 "$OUT/jt9"
      echo "✓ Built decoders/jt9/bin/jt9"
    else
      echo "(jt9 build path differs in this wsjtx revision; the Linux Docker stage handles it.)" >&2
    fi
    ;;
  *) echo "unsupported host $UNAME" >&2; exit 1;;
esac
