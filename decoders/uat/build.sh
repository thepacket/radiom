#!/usr/bin/env bash
# Build dump978-fa (flightaware/dump978) — actively-maintained UAT
# 978 MHz ADS-B-variant decoder used by US general aviation.
#
# Previous upstream `mutability/dump978` was archived in 2026; the
# flightaware fork is the live one (same lineage as our dump1090-fa).
# Wire shape used by radiom:
#   --stdin --format CS16H  : cs16 (int16 interleaved) IQ from stdin
#   --raw-stdout            : print raw UAT frames to stdout
# (no --raw-port / --json-port / --sdr — the bridge feeds samples
#  directly and reads stdout.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/uat"
OUT="$SRC/bin"
WORK="$SRC/build"
UAT_REF="${UAT_REF:-master}"
UAT_URL="${UAT_URL:-https://github.com/flightaware/dump978.git}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc g++ make git pkg-config; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d dump978 ]; then
      git clone --depth 1 --branch "$UAT_REF" "$UAT_URL" dump978
    fi
    cd dump978
    make -j "$(nproc 2>/dev/null || echo 2)" dump978-fa
    # Install as `dump978` so the bridge's existing BIN path doesn't
    # have to change.
    if   [ -x dump978-fa ]; then cp dump978-fa "$OUT/dump978"
    elif [ -x dump978 ];    then cp dump978    "$OUT/dump978"
    else
      echo "dump978-fa build produced no binary; build tree:" >&2
      ls -la >&2
      exit 1
    fi
    chmod +x "$OUT/dump978"
    echo "✓ Built decoders/uat/bin/dump978 (flightaware fork)"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds dump978.)" >&2
    ;;
esac
