#!/usr/bin/env bash
# Build dump1090-fa (flightaware/dump1090) — the actively-maintained
# successor to mutability/dump1090 (last touched circa 2017). Same
# `--ifile - --iformat SC16/UC8` CLI shape; binary renamed to
# `dump1090-fa` upstream.
#
# Mode-S / ADS-B 1090 MHz extended-squitter decoder. Bridge feeds
# 2 MS/s int16 LE IQ from the rtl_tcp proxy; binary prints raw beast
# messages on stdout via `--raw`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/adsb"
OUT="$SRC/bin"
WORK="$SRC/build"
ADSB_REF="${ADSB_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc make git pkg-config; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d dump1090 ]; then
      git clone --depth 1 --branch "$ADSB_REF" https://github.com/flightaware/dump1090.git dump1090
    fi
    cd dump1090
    # flightaware's Makefile derives the version string from
    # `git describe --tags`; a depth-1 clone has no tag history, so
    # the version field ends up as "unknown" and the startup banner
    # reads "dump1090-fa unknown starting up." Override via DUMP1090_VERSION
    # so the banner is readable in our status overlay.
    : "${DUMP1090_VERSION:=radiom-$(date +%Y%m%d)}"
    export DUMP1090_VERSION
    make DUMP1090_VERSION="$DUMP1090_VERSION"
    # Upstream now produces dump1090-fa; we install it as dump1090 so
    # the bridge spawn path doesn't change.
    if   [ -f dump1090-fa ]; then cp dump1090-fa "$OUT/dump1090"
    elif [ -f dump1090 ];    then cp dump1090    "$OUT/dump1090"
    fi
    [ -f "$OUT/dump1090" ] && echo "✓ Built decoders/adsb/bin/dump1090 (flightaware fork)"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds dump1090.)" >&2
    ;;
esac
