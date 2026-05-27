#!/usr/bin/env bash
# Vendor jbirby/COSPAS-SARSAT-406-MHz-Beacon-Codec — Python decoder
# for 406 MHz emergency beacons (ELT / EPIRB / PLB) per the COSPAS-
# SARSAT C/S T.001 (1G) and C/S T.018 (2G) specs.
#
# Previously attempted via zleffke/gr-sarsat (a GNU Radio out-of-tree
# module with no actual CLI binary — the old build.sh wrote a wrapper
# pointing at a non-existent Python module and silenced every error
# with `|| true`, shipping a broken shell shim). This swap drops the
# heavy GNU Radio runtime entirely and reuses the python3+numpy that
# the DSC bridge already brings to the runtime image.
#
# License: MIT (same author as our DSC vendoring).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/cospas"
OUT="$SRC/bin"
WORK="$SRC/build"
COSPAS_REF="${COSPAS_REF:-main}"
COSPAS_URL="${COSPAS_URL:-https://github.com/jbirby/COSPAS-SARSAT-406-MHz-Beacon-Codec.git}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux|Darwin)
    for cmd in git python3; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d cospas-sarsat ]; then
      git clone --depth 1 --branch "$COSPAS_REF" "$COSPAS_URL" cospas-sarsat
    fi
    cp cospas-sarsat/scripts/sarsat_decode.py "$OUT/cs406.py"
    cp cospas-sarsat/scripts/sarsat_common.py "$OUT/sarsat_common.py"
    chmod +x "$OUT/cs406.py"
    python3 -c "import ast; ast.parse(open('$OUT/cs406.py').read())"
    echo "✓ Staged decoders/cospas/bin/cs406.py (jbirby/COSPAS-SARSAT)"
    ;;
esac
