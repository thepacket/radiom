#!/usr/bin/env bash
# Build the fldigi-vendored CW decoder.
#
# Output: decoders/cw/bin/cw-decoder
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/cw"
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
  "$SRC/fldigi/cw.cxx"

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
      bash -c "apt-get update -qq && apt-get install -y -qq g++ && \
               g++ ${CXX_FLAGS[*]} -o /src/bin/cw-decoder ${SOURCES[*]/$SRC/\/src}"
    exit $?
    ;;
esac

"$CXX" "${CXX_FLAGS[@]}" -o "$OUT/cw-decoder" "${SOURCES[@]}"
echo "✓ Built $(file "$OUT/cw-decoder" | cut -d: -f2-)"
