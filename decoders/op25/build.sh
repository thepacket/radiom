#!/usr/bin/env bash
# Build OP25 (boatbod/op25 — actively maintained fork of osmocom/op25).
# Full P25 phase-1 + phase-2 trunking decoder with control-channel
# parsing, talkgroup tracking, and encryption-status reporting.
#
# Apps land under /usr/local/share/op25/apps via the staging tarball
# (cmake install only puts the C++ library bits in /usr/local; the
# Python entry scripts stay under the source tree). The wrapper at
# $OUT/op25-decode shells into rx.py.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/op25"
OUT="$SRC/bin"
WORK="$SRC/build"
OP25_REF="${OP25_REF:-master}"
OP25_URL="${OP25_URL:-https://github.com/boatbod/op25.git}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc g++ make git cmake python3; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d op25 ]; then
      git clone --depth 1 --branch "$OP25_REF" "$OP25_URL" op25
    fi
    cd op25
    # boatbod's install.sh expects this marker file telling rx.py
    # which python interpreter to invoke.
    echo "/usr/bin/python3" > op25/gr-op25_repeater/apps/op25_python
    # Out-of-tree cmake build at the repo root.
    rm -rf build
    mkdir -p build
    cd build
    cmake -DCMAKE_BUILD_TYPE=Release ..
    make -j "$(nproc 2>/dev/null || echo 2)"
    make install
    ldconfig
    # Sanity: rx.py must exist in the apps tree.
    APPS_DIR="$ROOT/decoders/op25/build/op25/op25/gr-op25_repeater/apps"
    test -f "$APPS_DIR/rx.py" || { echo "rx.py missing under $APPS_DIR" >&2; exit 1; }
    # Stage the apps tree (Python scripts, config samples) for the
    # Dockerfile to ship into the runtime image. cmake install copies
    # only the C++ extension modules; the Python wrappers stay here.
    tar czf "$OUT/op25-apps.tar.gz" -C "$ROOT/decoders/op25/build/op25/op25/gr-op25_repeater" apps
    # Shell wrapper invoked by the bridge — runs rx.py from the
    # staged apps tree with stdin IQ via -F /dev/stdin and an HTTP
    # terminal (-l http:...) so OP25 doesn't try to take over the
    # tty with curses.
    cat > "$OUT/op25-decode" <<'EOF'
#!/usr/bin/env bash
# OP25 launcher — feeds stdin IQ (complex cf32) to rx.py via /dev/stdin.
# Tunable via env:
#   OP25_SAMPLE_RATE  source sample rate in Hz (default 96000)
#   OP25_DEMOD        cqpsk (P25 Phase 1 LSM/CQPSK) or fsk4 (Phase 2 H-DQPSK)
#   OP25_OPTS         any additional rx.py flags
APPS=/usr/local/share/op25/apps
exec python3 "$APPS/rx.py" -F /dev/stdin -l 'http:127.0.0.1:8000' \
     -D "${OP25_DEMOD:-cqpsk}" -S "${OP25_SAMPLE_RATE:-96000}" \
     ${OP25_OPTS:-} "$@"
EOF
    chmod +x "$OUT/op25-decode"
    echo "✓ Built OP25 (boatbod fork) — apps tarball + launcher wrapper"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds OP25.)" >&2
    ;;
esac
