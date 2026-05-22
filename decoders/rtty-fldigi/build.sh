#!/usr/bin/env bash
# Build the fldigi-vendored RTTY decoder.
#
# Output: decoders/rtty-fldigi/bin/rtty-fldigi-decoder
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/rtty-fldigi"
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
  -Wno-sign-compare
  -Wno-write-strings
)

SOURCES=(
  "$SRC/main.cpp"
  "$SRC/fldigi_glue.cpp"
  "$SRC/fldigi/rtty.cxx"
  "$SRC/fldigi/filters.cxx"
  "$SRC/fldigi/fftfilt.cxx"
  "$SRC/fldigi/misc.cxx"
)

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)  CXX="${CXX:-g++}";;
  Darwin) CXX="${CXX:-clang++}";;
  *)
    docker run --rm -v "$SRC":/src -w /src debian:stable-slim \
      bash -c "apt-get update -qq && apt-get install -y -qq g++ && \
               g++ ${CXX_FLAGS[*]} -o /src/bin/rtty-fldigi-decoder ${SOURCES[*]/$SRC/\/src}"
    exit $?
    ;;
esac

"$CXX" "${CXX_FLAGS[@]}" -o "$OUT/rtty-fldigi-decoder" "${SOURCES[@]}"
echo "✓ Built $(file "$OUT/rtty-fldigi-decoder" | cut -d: -f2-)"
