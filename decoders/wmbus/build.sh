#!/usr/bin/env bash
# Build wmbusmeters (wmbusmeters/wmbusmeters) — Wireless M-Bus
# (utility meter telemetry, 868 MHz EU). Decodes Kamstrup,
# Diehl, Itron, Sensus, Honeywell water/gas/electric/heat meters.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/wmbus"
OUT="$SRC/bin"
WORK="$SRC/build"
WMB_REF="${WMB_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc g++ make git cmake; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d wmbusmeters ]; then
      git clone --depth 1 --branch "$WMB_REF" https://github.com/wmbusmeters/wmbusmeters.git wmbusmeters
    fi
    cd wmbusmeters
    make
    [ -f build/wmbusmeters ] && cp build/wmbusmeters "$OUT/wmbusmeters" && \
      echo "✓ Built decoders/wmbus/bin/wmbusmeters"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds wmbusmeters.)" >&2
    ;;
esac
