#!/usr/bin/env bash
# Build gr-lora_sdr (tapparelj/gr-lora_sdr) — EPFL/TCL's active LoRa
# decoder GNU Radio out-of-tree module. Decodes EU 868 MHz, US 915
# MHz, and AS 433 MHz LoRa packets with all spreading factors (SF7-12)
# and bandwidths (125/250/500 kHz).
#
# The repo ships a Python entry script we wrap as a stdin-reading
# binary. GNU Radio runtime + Python bindings must be present at
# build time — the Dockerfile stage installs them.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/lora"
OUT="$SRC/bin"
WORK="$SRC/build"
LORA_REF="${LORA_REF:-master}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc g++ make git cmake python3; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d gr-lora_sdr ]; then
      git clone --depth 1 --branch "$LORA_REF" https://github.com/tapparelj/gr-lora_sdr.git gr-lora_sdr
    fi
    cd gr-lora_sdr
    mkdir -p build && cd build
    cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local ..
    make -j "$(nproc 2>/dev/null || echo 2)" install
    ldconfig
    # Install the wrapper script that reads CS16 IQ on stdin and runs
    # the standard "single-channel receiver" flowgraph. Fail loud if
    # the wrapper went missing — the previous `|| true` silently
    # shipped a non-functional decoder.
    if [ ! -f "$SRC/lora_decode.py" ]; then
      echo "ERROR: lora_decode.py wrapper missing under $SRC" >&2
      exit 1
    fi
    cp "$SRC/lora_decode.py" "$OUT/lora_decode.py"
    # Tiny shim so the bridge spawns it like any other vendored bin.
    cat > "$OUT/lora-decode" <<'EOF'
#!/usr/bin/env bash
exec python3 "$(dirname "$0")/lora_decode.py" "$@"
EOF
    chmod +x "$OUT/lora-decode"
    # Verify the gr-lora_sdr Python module actually imported after
    # install — silent installs that fail to wire up the binding are
    # the most common silent-success failure mode for GR OOT builds.
    if ! python3 -c "from gnuradio import lora_sdr" 2>&1; then
      echo "ERROR: gnuradio.lora_sdr import failed post-install" >&2
      exit 1
    fi
    echo "✓ Built decoders/lora/bin/lora-decode (gr-lora_sdr Python entry)"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds gr-lora_sdr.)" >&2
    ;;
esac
