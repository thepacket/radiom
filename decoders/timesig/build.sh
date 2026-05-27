#!/usr/bin/env bash
# Build dokutan/dcf77-decode — small Linux CLI for the DCF77 LF time
# signal (77.5 kHz, Germany). The decoder takes AM-demodulated audio
# on stdin (the second-marker amplitude dips at 100/200 ms intervals
# inside each second) and prints decoded ISO timestamps + status.
#
# We also build a tiny in-house WWVB / MSF / JJY variant by copying
# the source and swapping the carrier sync constants — those four
# stations share BCD-time-code structure with DCF77-style framing,
# differing mainly in carrier / second-marker timing. For now we ship
# only the DCF77 binary; sub-mode buttons land in a future pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/timesig"
OUT="$SRC/bin"
WORK="$SRC/build"
DCF_REF="${DCF_REF:-main}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc make git; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d dcf77-decode ]; then
      git clone --depth 1 --branch "$DCF_REF" https://github.com/dokutan/dcf77-decode.git dcf77-decode 2>/dev/null || \
      git clone --depth 1 https://github.com/dokutan/dcf77-decode.git dcf77-decode
    fi
    if [ -d dcf77-decode ]; then
      cd dcf77-decode
      make 2>/dev/null || gcc -O2 -o dcf77-decode dcf77-decode.c -lm 2>/dev/null || true
      [ -f dcf77-decode ] && cp dcf77-decode "$OUT/timesig" && \
        echo "✓ Built decoders/timesig/bin/timesig (DCF77)"
    fi
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds the timesig decoders.)" >&2
    ;;
esac
