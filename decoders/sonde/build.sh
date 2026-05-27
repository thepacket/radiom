#!/usr/bin/env bash
# Build the radiosonde decoder family from rs1729/RS.
#
# Sources live in RS/demod/mod (not RS/rs41 — the rs41/ dir contains
# the older single-file decoders; the mod variants under demod/mod
# share demod_mod.o + bch_ecc_mod.o and are what rs1729 documents in
# his current README as the recommended decoders).
#
# Compile recipe per RS/demod/mod/README.md:
#   gcc -c demod_mod.c
#   gcc -c bch_ecc_mod.c
#   gcc rs41mod.c demod_mod.o bch_ecc_mod.o -lm -o rs41mod
#   gcc dfm09mod.c demod_mod.o -lm -o dfm09mod
#   gcc m10mod.c   demod_mod.o -lm -o m10mod
#
# Each binary reads int16 LE WAV from stdin (auto-detects sample rate
# from the header) or via a positional filename. Mono works; the
# `- <rate> <bits>` headerless stdin mode is stereo-only so we send
# WAV-framed audio from the bridge.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/sonde"
OUT="$SRC/bin"
WORK="$SRC/build"
SONDE_REF="${SONDE_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc make git; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d RS ]; then
      git clone --depth 1 --branch "$SONDE_REF" https://github.com/rs1729/RS.git RS
    fi
    cd RS/demod/mod
    gcc -O2 -c demod_mod.c
    gcc -O2 -c bch_ecc_mod.c
    # Each mod variant gets compiled to a standalone binary. The list
    # mirrors RS/demod/mod/README.md but limited to the protocols still
    # in active service (others compile fine but produce no traffic).
    declare -A SOURCES=(
      [rs41mod]="rs41mod.c demod_mod.o bch_ecc_mod.o"
      [dfm09mod]="dfm09mod.c demod_mod.o"
      [m10mod]="m10mod.c demod_mod.o"
      [imet54mod]="imet54mod.c demod_mod.o"
      [lms6Xmod]="lms6Xmod.c demod_mod.o bch_ecc_mod.o"
      [mp3h1mod]="mp3h1mod.c demod_mod.o"
    )
    built=0
    for name in "${!SOURCES[@]}"; do
      # shellcheck disable=SC2086
      if gcc -O2 ${SOURCES[$name]} -lm -o "$name"; then
        cp "$name" "$OUT/$name"
        built=$((built+1))
      else
        echo "warn: $name failed to build (continuing)" >&2
      fi
    done
    if [ "$built" -eq 0 ]; then
      echo "ERROR: no sonde decoders built" >&2
      ls -la >&2
      exit 1
    fi
    # Default-sonde symlink for the legacy bridge call paths.
    if [ -f "$OUT/rs41mod" ]; then
      ln -sf rs41mod "$OUT/sonde"
    fi
    echo "✓ Built $built sonde decoder(s); default → rs41mod"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds the sonde decoders.)" >&2
    ;;
esac
