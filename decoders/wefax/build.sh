#!/usr/bin/env bash
# Build the fldigi-vendored WEFAX decoder.
#
# Output: decoders/wefax/bin/wefax-decoder
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/wefax"
OUT="$SRC/bin"
mkdir -p "$OUT"

CXX_FLAGS=(
  -O2 -std=c++17 -pthread
  -DNDEBUG
  -I "$SRC/stubs"
  -I "$SRC/fldigi"
  -Wno-unused-result
  -Wno-deprecated-declarations
  -Wno-unused-variable
  -Wno-unused-parameter
)

SOURCES=(
  "$SRC/main.cpp"
  "$SRC/fldigi_glue.cpp"
  "$SRC/fldigi/wefax.cxx"
  "$SRC/fldigi/morse.cxx"
  "$SRC/fldigi/fftfilt.cxx"
  "$SRC/fldigi/filters.cxx"
  "$SRC/fldigi/misc.cxx"
)

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)  CXX="${CXX:-g++}";;
  Darwin) CXX="${CXX:-clang++}";;
  *)
    docker run --rm -v "$SRC":/src -w /src debian:stable-slim \
      bash -c "apt-get update -qq && apt-get install -y -qq g++ libc6-dev > /dev/null && \
               g++ ${CXX_FLAGS[*]} -o /src/bin/wefax-decoder ${SOURCES[*]/$SRC/\/src}"
    exit $?
    ;;
esac

"$CXX" "${CXX_FLAGS[@]}" -o "$OUT/wefax-decoder" "${SOURCES[@]}"
echo "✓ Built decoders/wefax/bin/wefax-decoder"
