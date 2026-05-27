#!/usr/bin/env bash
# Vendor jbirby/DSC-Codec — Python decoder for Digital Selective
# Calling (ITU-R M.493). Handles VHF Ch 70 (156.525 MHz) and the six
# HF guard channels (2187.5, 4207.5, 6312, 8414.5, 12577, 16804.5 kHz).
#
# This isn't a "build" in the compiled sense — we just clone the
# scripts and stage them where the bridge can run them via python3.
# Runtime depends on python3 + python3-numpy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/dsc"
OUT="$SRC/bin"
WORK="$SRC/build"
DSC_REF="${DSC_REF:-main}"
DSC_URL="${DSC_URL:-https://github.com/jbirby/DSC-Codec.git}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux|Darwin)
    for cmd in git python3; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d DSC-Codec ]; then
      git clone --depth 1 --branch "$DSC_REF" "$DSC_URL" DSC-Codec
    fi
    # Copy decoder scripts to OUT — bridge invokes
    # `python3 <OUT>/dsc_decode.py <wavfile>`.
    cp DSC-Codec/scripts/dsc_decode.py "$OUT/dsc_decode.py"
    cp DSC-Codec/scripts/dsc_common.py "$OUT/dsc_common.py"
    chmod +x "$OUT/dsc_decode.py"
    # Quick syntax check — if the script has an import error this
    # surfaces here at build time instead of every WS session.
    python3 -c "import ast; ast.parse(open('$OUT/dsc_decode.py').read())"
    echo "✓ Staged decoders/dsc/bin/dsc_decode.py (jbirby/DSC-Codec)"
    ;;
esac
