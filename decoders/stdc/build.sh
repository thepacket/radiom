#!/usr/bin/env bash
# Build scytale-c (sigsegv-mvm/scytale) — Inmarsat STD-C decoder.
# STD-C is the messaging / EGC distress-alert protocol used by every
# vessel >300 GT under SOLAS. 1.5 GHz L-band downlink, BPSK 600 bps
# inside a ~1.2 kHz channel. Decodes ship-shore messages, EGC
# fleet broadcasts, distress alerts.
#
# scytale-c reads int16 LE 48 kHz audio from stdin (output of a SAM
# or USB demodulator pointed at an Inmarsat-C NCS or LES channel)
# and emits decoded messages on stdout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/stdc"
OUT="$SRC/bin"
WORK="$SRC/build"
STDC_REF="${STDC_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc make git cmake; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d scytale-c ]; then
      git clone --depth 1 --branch "$STDC_REF" https://github.com/sigsegv-mvm/scytale-c.git scytale-c 2>/dev/null || \
      git clone --depth 1 https://github.com/sigsegv-mvm/scytale-c.git scytale-c
    fi
    if [ -d scytale-c ]; then
      cd scytale-c
      mkdir -p build && cd build
      cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null 2>&1 || true
      make 2>/dev/null || true
      for cand in scytale-c stdc-decoder stdc; do
        [ -f "$cand" ] && cp "$cand" "$OUT/scytale-c" && break
      done
      [ -f "$OUT/scytale-c" ] && echo "✓ Built decoders/stdc/bin/scytale-c"
    fi
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds scytale-c.)" >&2
    ;;
esac
