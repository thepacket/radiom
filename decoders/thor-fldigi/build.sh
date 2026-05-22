#!/usr/bin/env bash
# Build the fldigi-vendored THOR decoder.
#
# Output: decoders/thor-fldigi/bin/thor-fldigi-decoder
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/thor-fldigi"
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
  "$SRC/fldigi/thor.cxx"
  "$SRC/fldigi/thorvaricode.cxx"
  "$SRC/fldigi/mfskvaricode.cxx"
  "$SRC/fldigi/dominovar.cxx"
  "$SRC/fldigi/interleave.cxx"
  "$SRC/fldigi/viterbi.cxx"
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
               g++ ${CXX_FLAGS[*]} -o /src/bin/thor-fldigi-decoder ${SOURCES[*]/$SRC/\/src}"
    exit $?
    ;;
esac

"$CXX" "${CXX_FLAGS[@]}" -o "$OUT/thor-fldigi-decoder" "${SOURCES[@]}"
echo "✓ Built $(file "$OUT/thor-fldigi-decoder" | cut -d: -f2-)"
