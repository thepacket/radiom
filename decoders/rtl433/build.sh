#!/usr/bin/env bash
# Build rtl_433 (merbanan/rtl_433) — the ISM-band protocol zoo. Single
# C binary decodes ~200 devices: weather stations (Acurite, La Crosse,
# Oregon Scientific, Fineoffset, Bresser), TPMS, water/gas/electric
# meters, smart plugs, security sensors (Honeywell DSC), garage door
# remotes, EnOcean partial, X10, Somfy blinds, many more.
#
# Reads UC8 IQ (or int16 with -F flag) from stdin via `-r -` (or
# `-c -` for CU8 / `-c -F` for CS16). Default rate 250 kHz. Emits
# JSON one-line-per-decode on stdout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/rtl433"
OUT="$SRC/bin"
WORK="$SRC/build"
R433_REF="${R433_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc make git cmake; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d rtl_433 ]; then
      git clone --depth 1 --branch "$R433_REF" https://github.com/merbanan/rtl_433.git rtl_433
    fi
    cd rtl_433
    mkdir -p build && cd build
    # ENABLE_RTLSDR=OFF — we don't bind directly to USB, the bridge
    # pipes samples in via stdin. SOAPYSDR off for the same reason.
    cmake -DCMAKE_BUILD_TYPE=Release -DENABLE_RTLSDR=OFF -DENABLE_SOAPYSDR=OFF ..
    make -j "$(nproc 2>/dev/null || echo 2)" rtl_433
    # Newer rtl_433 lands the binary at src/rtl_433 (out-of-tree
    # build), older trees drop it in the build root. Handle both.
    if   [ -x src/rtl_433 ]; then SRC_BIN=src/rtl_433
    elif [ -x rtl_433 ];     then SRC_BIN=rtl_433
    else
      echo "rtl_433 build produced no binary; build tree:" >&2
      find . -maxdepth 3 -name rtl_433 -type f >&2 || true
      exit 1
    fi
    cp "$SRC_BIN" "$OUT/rtl_433"
    chmod +x "$OUT/rtl_433"
    echo "✓ Built decoders/rtl433/bin/rtl_433 (from $SRC_BIN)"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds rtl_433.)" >&2
    ;;
esac
