#!/usr/bin/env bash
# Build multimon-ng (EliasOenal/multimon-ng) — Thomas Sailer's classic
# tinydecoder collection, modernised by Elias Önal. Decodes a long list
# of HF / VHF protocols from raw audio, including:
#
#   SELCAL    — aviation HF selective calling (2-of-16 tone code)
#   POCSAG    — VHF pager protocol
#   FLEX      — newer pager protocol
#   EAS       — Emergency Alert System
#   DTMF      — telephone tone dialing
#   ZVEI / EEA / EIA — European 2-tone calling protocols
#   FMSFSK    — fire / EMS dispatch
#   ... and others (run `multimon-ng -h` for the full list)
#
# All modes share the same audio in / text out wire shape, so this
# single binary unlocks several decoders. radiom currently surfaces
# SELCAL on page 9; new modes can be added later by spawning the same
# binary with a different `-a` flag.
#
# Build deps:  gcc, cmake, make, git
# Runtime deps: none (statically linkable)
#
# Output: decoders/multimon/bin/multimon-ng
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/multimon"
OUT="$SRC/bin"
WORK="$SRC/build"
MULTIMON_REF="${MULTIMON_REF:-master}"

mkdir -p "$OUT" "$WORK"

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc cmake make git; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d multimon-ng ]; then
      git clone --depth 1 --branch "$MULTIMON_REF" \
        https://github.com/EliasOenal/multimon-ng.git multimon-ng
    fi
    cd multimon-ng
    mkdir -p build_linux && cd build_linux
    cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null
    make -j multimon-ng
    cp multimon-ng "$OUT/multimon-ng"
    echo "✓ Built decoders/multimon/bin/multimon-ng"
    ;;
  Darwin)
    if ! command -v cmake >/dev/null; then
      echo "Install cmake first: brew install cmake" >&2
      exit 0
    fi
    cd "$WORK"
    if [ ! -d multimon-ng ]; then
      git clone --depth 1 --branch "$MULTIMON_REF" \
        https://github.com/EliasOenal/multimon-ng.git multimon-ng
    fi
    cd multimon-ng
    mkdir -p build_mac && cd build_mac
    cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null || {
      echo "(macOS build needs Xcode CLT; Linux Docker stage handles it.)" >&2
      exit 0
    }
    make -j multimon-ng || true
    [ -f multimon-ng ] && cp multimon-ng "$OUT/multimon-ng" && \
      echo "✓ Built decoders/multimon/bin/multimon-ng"
    ;;
  *) echo "unsupported host $UNAME" >&2; exit 1;;
esac
