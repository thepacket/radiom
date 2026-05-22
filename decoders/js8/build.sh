#!/usr/bin/env bash
# Fetch & build the JS8Call decoder (`js8`) from js8call source.
#
# JS8Call is the FT8-derived keyboard-QSO mode. The standalone `js8`
# binary decodes 15-second WAV files (Normal mode) and emits one text
# line per decoded message — similar in spirit to wsprd / jt9.
#
# Build deps:  gcc, gfortran, libfftw3-dev (single-precision), cmake, qt5 dev (for some headers, even for CLI build)
# Runtime deps: libfftw3-single3, libgomp1
#
# Output: decoders/js8/bin/js8
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/js8"
OUT="$SRC/bin"
WORK="$SRC/build"
JS8_REF="${JS8_REF:-master}"

mkdir -p "$OUT" "$WORK"

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gfortran gcc git cmake; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d js8call ]; then
      git clone --depth 1 --branch "$JS8_REF" \
        https://bitbucket.org/widefido/js8call.git js8call
    fi
    cd js8call
    mkdir -p build && cd build
    # Disable building the Qt GUI; we only need the lib/ decoder.
    cmake -DCMAKE_BUILD_TYPE=Release ..
    # Build only the js8 decoder target.
    make -j"$(nproc)" js8 || make js8
    rm -f "$OUT/js8"
    cp js8 "$OUT/js8"
    echo "✓ Built decoders/js8/bin/js8"
    ;;
  Darwin)
    # macOS dev: gfortran/fftw via homebrew (`brew install gcc fftw cmake`).
    if ! command -v gfortran >/dev/null; then
      echo "Install gfortran first: brew install gcc" >&2
      echo "(Skipping local build — Linux Docker stage will produce the runtime binary.)" >&2
      exit 0
    fi
    cd "$WORK"
    if [ ! -d js8call ]; then
      git clone --depth 1 --branch "$JS8_REF" \
        https://bitbucket.org/widefido/js8call.git js8call
    fi
    cd js8call
    mkdir -p build && cd build
    BREW_FFTW="$(brew --prefix fftw 2>/dev/null || echo '')"
    EXTRA=""
    [ -n "$BREW_FFTW" ] && EXTRA="-DFFTW3_INCLUDE_DIR=$BREW_FFTW/include -DFFTW3_LIBRARY=$BREW_FFTW/lib/libfftw3f.dylib"
    cmake -DCMAKE_BUILD_TYPE=Release $EXTRA ..
    make js8 || true
    if [ -f js8 ]; then
      cp js8 "$OUT/js8"
      echo "✓ Built decoders/js8/bin/js8"
    else
      echo "(JS8 build did not produce js8 binary; the Linux Docker stage will produce the runtime artifact.)" >&2
    fi
    ;;
  *) echo "unsupported host $UNAME" >&2; exit 1;;
esac
