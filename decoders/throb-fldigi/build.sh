#!/usr/bin/env bash
# Build the fldigi-vendored Throb decoder.
#
# Throb is a 9-tone pulse-position-modulated chat mode (G3PLX, ca.
# 2003). Variants: Throb1 / Throb2 / Throb4 — bd rate per character —
# plus ThrobX1 / X2 / X4 which add a self-clocking inner FEC. fldigi's
# `throb` class handles all of them via a trx_mode argument.
#
# As with pi4-fldigi we keep the diff tiny: clone fldigi at build time,
# copy only throb.cxx + throb.h into the local tree, compile against
# the SHARED DSP / stubs / glue pool already vendored under
# decoders/mfsk-fldigi/.
#
# Output: decoders/throb-fldigi/bin/throb-fldigi-decoder
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/throb-fldigi"
SHARED="$ROOT/decoders/mfsk-fldigi"
OUT="$SRC/bin"
WORK="$SRC/build"
FLDIGI_REF="${FLDIGI_REF:-master}"

mkdir -p "$OUT" "$WORK" "$SRC/fldigi"

if [ ! -f "$SRC/fldigi/throb.cxx" ] || [ ! -f "$SRC/fldigi/throb.h" ]; then
  if [ ! -d "$WORK/fldigi" ]; then
    git clone --depth 1 --branch "$FLDIGI_REF" \
      https://git.code.sf.net/p/fldigi/fldigi "$WORK/fldigi"
  fi
  # fldigi's source layout: implementations live in src/<mode>/,
  # public headers in src/include/. throb.cxx is under src/throb/ but
  # throb.h is under src/include/ — the original lookup chain didn't
  # check src/include and failed loudly. Add it.
  for f in throb.cxx throb.h; do
    if   [ -f "$WORK/fldigi/src/throb/$f" ];   then cp "$WORK/fldigi/src/throb/$f"   "$SRC/fldigi/$f"
    elif [ -f "$WORK/fldigi/src/include/$f" ]; then cp "$WORK/fldigi/src/include/$f" "$SRC/fldigi/$f"
    elif [ -f "$WORK/fldigi/src/cw_rtty/$f" ]; then cp "$WORK/fldigi/src/cw_rtty/$f" "$SRC/fldigi/$f"
    elif [ -f "$WORK/fldigi/src/$f" ];         then cp "$WORK/fldigi/src/$f"         "$SRC/fldigi/$f"
    else
      echo "Couldn't find $f in fldigi source tree" >&2
      find "$WORK/fldigi/src" -name "$f" >&2 || true
      exit 1
    fi
  done
fi

CXX_FLAGS=(
  -O2 -std=c++17 -pthread
  -DNDEBUG
  -I "$SHARED/stubs"
  -I "$SHARED/fldigi"
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
  "$SHARED/fldigi_glue.cpp"
  "$SRC/fldigi/throb.cxx"
  "$SHARED/fldigi/filters.cxx"
  "$SHARED/fldigi/fftfilt.cxx"
  "$SHARED/fldigi/misc.cxx"
)

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)  CXX="${CXX:-g++}";;
  Darwin) CXX="${CXX:-clang++}";;
  *)
    docker run --rm -v "$ROOT":/repo -w /repo debian:stable-slim \
      bash -c "apt-get update -qq && apt-get install -y -qq g++ git && \
               bash /repo/decoders/throb-fldigi/build.sh"
    exit $?
    ;;
esac

"$CXX" "${CXX_FLAGS[@]}" -o "$OUT/throb-fldigi-decoder" "${SOURCES[@]}"
echo "✓ Built $(file "$OUT/throb-fldigi-decoder" | cut -d: -f2-)"
