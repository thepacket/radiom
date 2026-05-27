#!/usr/bin/env bash
# Build alphafox02/inmarsat-sniffer — Qt-stripped C++ port of JAERO's
# DSP. Decodes Inmarsat AERO Classic (aviation ACARS/ADS-C/CPDLC) and
# STD-C (maritime safety messaging) from raw L-band IQ. Single binary,
# no Qt / no Python / no Java.
#
# Replaces the previous jontio/JAERO attempt — upstream JAERO is GUI-
# only and has no headless CLI branch (we tried; it doesn't build).
# inmarsat-sniffer is explicitly the headless option in this space.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/jaero"
OUT="$SRC/bin"
WORK="$SRC/build"
SNIFF_REF="${SNIFF_REF:-main}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc g++ make git cmake; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d inmarsat-sniffer ]; then
      git clone --depth 1 --branch "$SNIFF_REF" https://github.com/alphafox02/inmarsat-sniffer.git inmarsat-sniffer
    fi
    cd inmarsat-sniffer
    # SIMD safety net (part 1): force the runtime dispatcher to the
    # SSE4.2 kernel. simd_init takes a simd_mode_t enum (NOT a bool;
    # the header comment is misleading):
    #   SIMD_AUTO=0, SIMD_AVX2=1, SIMD_SSE42=2, SIMD_NEON=3, SIMD_SCALAR=4
    sed -i 's/simd_init(0)/simd_init(2)/' main.c
    grep -n "simd_init" main.c >&2 || true

    # SIMD safety net (part 2): upstream's CMakeLists hardcodes
    #   set(CMAKE_C_FLAGS_RELEASE "-O3 -march=native")
    # `-march=native` picks up every ISA feature the BUILD HOST CPU
    # advertises — including AVX2 on Docker BuildKit boxes — and the
    # compiler then auto-vectorizes EVERY source file with AVX2
    # instructions. LTO (INTERPROCEDURAL_OPTIMIZATION TRUE) then
    # propagates those across translation units, so AVX2 ends up
    # baked into the main control flow regardless of which dispatch
    # kernel runs. On fly.io VMs whose CPUID lies about AVX2 → SIGILL.
    #
    # Override with -march=x86-64-v2 (SSE4.2-baseline psABI; safe on
    # every 64-bit Linux host released since ~2009).
    sed -i 's/-march=native/-march=x86-64-v2/g' CMakeLists.txt
    grep -n "march=" CMakeLists.txt >&2 || true
    mkdir -p build && cd build
    cmake -DCMAKE_BUILD_TYPE=Release ..
    make -j "$(nproc 2>/dev/null || echo 2)"
    # Install the binary as `jaero-cli` so the bridge's existing path
    # assumption doesn't need rewriting.
    if   [ -x inmarsat-sniffer ];     then cp inmarsat-sniffer "$OUT/jaero-cli"
    elif [ -x src/inmarsat-sniffer ]; then cp src/inmarsat-sniffer "$OUT/jaero-cli"
    else
      echo "inmarsat-sniffer build produced no binary; build tree:" >&2
      ls -la >&2
      exit 1
    fi
    echo "✓ Built decoders/jaero/bin/jaero-cli (inmarsat-sniffer)"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds inmarsat-sniffer.)" >&2
    ;;
esac
