#!/usr/bin/env bash
# Build the fldigi-vendored RSID auto-classifier.
# Output: decoders/rsid/bin/rsid-decoder
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/rsid"
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
  "$SRC/fldigi/rsid.cxx"
  "$SRC/fldigi/globals.cxx"
  "$SRC/fldigi/morse.cxx"
  "$SRC/fldigi/fftfilt.cxx"
  "$SRC/fldigi/filters.cxx"
  "$SRC/fldigi/misc.cxx"
)

LIBS=(-lsamplerate)

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    CXX="${CXX:-g++}"
    ;;
  Darwin)
    CXX="${CXX:-clang++}"
    # Homebrew ships libsamplerate under /opt/homebrew on Apple Silicon,
    # /usr/local on Intel — pick whichever exists.
    for p in /opt/homebrew/opt/libsamplerate /usr/local/opt/libsamplerate; do
      if [ -d "$p" ]; then
        CXX_FLAGS+=( -I "$p/include" )
        LIBS=( -L "$p/lib" "${LIBS[@]}" )
        break
      fi
    done
    ;;
  *) echo "unsupported host $UNAME" >&2; exit 1;;
esac

"$CXX" "${CXX_FLAGS[@]}" -o "$OUT/rsid-decoder" "${SOURCES[@]}" "${LIBS[@]}"
echo "✓ Built decoders/rsid/bin/rsid-decoder"
