#!/usr/bin/env bash
# Build GopherTrunk (MattCheramie/GopherTrunk) — pure-Go trunked
# radio scanner. Supports LTR, P25, DMR, TETRA, NXDN control-channel
# decode with native IMBE / AMBE+2 vocoders for voice output.
#
# For radiom we use it specifically as the LTR (Logic Trunked Radio
# / LTR-Net) decoder — the one trunking format not already covered
# by DSD-FME (voice) or OP25 (P25 trunking). GopherTrunk's CLI takes
# raw IQ on stdin via `--source stdin` (CS16, default 250 kS/s) and
# emits JSON-per-event on stdout: channel, LCN, talkgroup, ID.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/ltr"
OUT="$SRC/bin"
WORK="$SRC/build"
LTR_REF="${LTR_REF:-main}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in go git; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d GopherTrunk ]; then
      git clone --depth 1 --branch "$LTR_REF" https://github.com/MattCheramie/GopherTrunk.git GopherTrunk
    fi
    cd GopherTrunk
    # Compile the trunked-scanner CLI. The Go module layout varies by
    # revision — try `./cmd/gophertrunk`, then top-level `main.go`.
    if [ -d cmd/gophertrunk ]; then
      go build -o "$OUT/gophertrunk" ./cmd/gophertrunk
    else
      go build -o "$OUT/gophertrunk" ./...
    fi
    [ -f "$OUT/gophertrunk" ] && echo "✓ Built decoders/ltr/bin/gophertrunk"
    ;;
  Darwin)
    if command -v go >/dev/null; then
      cd "$WORK"
      [ -d GopherTrunk ] || git clone --depth 1 --branch "$LTR_REF" \
        https://github.com/MattCheramie/GopherTrunk.git GopherTrunk
      cd GopherTrunk
      go build -o "$OUT/gophertrunk" ./... 2>/dev/null || \
        echo "(macOS build skipped — Linux Docker stage handles it.)" >&2
    fi
    ;;
esac
