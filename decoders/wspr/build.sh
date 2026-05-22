#!/usr/bin/env bash
# Fetch & build the WSPR decoder (`wsprd`) from wsjt-x source.
#
# wsprd is a small standalone binary that decodes WSPR-2 transmissions
# from a 12 kHz mono int16 WAV file. We build only the wsprd target —
# wsjtx itself drags in Qt5 which we don't need for the decoder.
#
# Build deps:  gcc, gfortran, libfftw3-dev (single-precision)
# Runtime deps: libfftw3-single3
#
# Output: decoders/wspr/bin/wsprd
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/wspr"
OUT="$SRC/bin"
WORK="$SRC/build"
WSJTX_REF="${WSJTX_REF:-master}"

mkdir -p "$OUT" "$WORK"

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    if ! command -v gfortran >/dev/null;       then echo "gfortran required";    exit 1; fi
    if ! command -v gcc      >/dev/null;       then echo "gcc required";         exit 1; fi
    if ! command -v git      >/dev/null;       then echo "git required";         exit 1; fi
    cd "$WORK"
    if [ ! -d wsjtx ]; then
      git clone --depth 1 --branch "$WSJTX_REF" \
        https://git.code.sf.net/p/wsjt/wsjtx wsjtx
    fi
    cd wsjtx/lib/wsprd
    make wsprd >/dev/null
    rm -f "$OUT/wsprd"
    cp wsprd "$OUT/wsprd"
    echo "✓ Built decoders/wspr/bin/wsprd"
    ;;
  Darwin)
    # macOS dev: gfortran/fftw via homebrew (`brew install gcc fftw`).
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
    cd wsjtx/lib/wsprd
    # Homebrew fftw and gcc live outside the default include/lib path.
    # CFLAGS/LDFLAGS must be passed as make *arguments* (not env vars)
    # because the upstream Makefile hardcodes CFLAGS and ignores env.
    BREW_FFTW="$(brew --prefix fftw 2>/dev/null || echo '')"
    BREW_GCC_LIB="/opt/homebrew/lib/gcc/current"
    if [ -n "$BREW_FFTW" ]; then
      make wsprd \
        CFLAGS="-I$BREW_FFTW/include -Wall -Wno-missing-braces -Wno-unused-result -O3 -ffast-math" \
        LDFLAGS="-L$BREW_FFTW/lib -L$BREW_GCC_LIB" >/dev/null
    else
      make wsprd >/dev/null
    fi
    cp wsprd "$OUT/wsprd"
    echo "✓ Built decoders/wspr/bin/wsprd"
    ;;
  *) echo "unsupported host $UNAME" >&2; exit 1;;
esac
