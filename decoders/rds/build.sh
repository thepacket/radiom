#!/usr/bin/env bash
# Build redsea (windytan/redsea) — RDS subcarrier decoder for FM
# broadcast (88–108 MHz). Reads mono int16 LE at 171 kHz from
# stdin (the 57 kHz RDS subcarrier sampled at 3× by upstream
# convention), writes JSON RDS groups on stdout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/rds"
OUT="$SRC/bin"
WORK="$SRC/build"
RDS_REF="${RDS_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    # redsea is Rust — needs cargo.
    for cmd in cargo git; do
      command -v "$cmd" >/dev/null || { echo "$cmd required (install rustup or apt-get install cargo)" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d redsea ]; then
      git clone --depth 1 --branch "$RDS_REF" https://github.com/windytan/redsea.git redsea
    fi
    cd redsea
    cargo build --release
    cp target/release/redsea "$OUT/redsea"
    echo "✓ Built decoders/rds/bin/redsea"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds redsea.)" >&2
    ;;
esac
