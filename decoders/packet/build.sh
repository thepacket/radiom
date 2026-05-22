#!/usr/bin/env bash
# Fetch & build direwolf for the AX.25/APRS HF packet decoder path.
#
# direwolf is a sizeable C codebase with build-time choices (ALSA vs.
# PortAudio vs. sndio). On Linux/Docker we use ALSA — it accepts the
# `stdin` pseudo-device cleanly. macOS dev builds aren't supported by
# this script; on macOS install via `brew install direwolf` instead.
#
# Output: decoders/packet/bin/direwolf
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/packet"
OUT="$SRC/bin"
WORK="$SRC/build"
DIREWOLF_REF="${DIREWOLF_REF:-1.8.1}"

mkdir -p "$OUT" "$WORK"

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    if ! command -v cmake >/dev/null;     then echo "cmake required";     exit 1; fi
    if ! command -v git   >/dev/null;     then echo "git required";       exit 1; fi
    cd "$WORK"
    if [ ! -d direwolf ]; then
      git clone --depth 1 --branch "$DIREWOLF_REF" \
        https://github.com/wb2osz/direwolf.git direwolf
    fi
    cd direwolf
    cmake -B build -DUNITTEST=OFF -DCMAKE_BUILD_TYPE=Release \
                   -DBUILD_HAMLIB=OFF -DBUILD_GPSD=OFF \
                   -DBUILD_CM108=OFF -DBUILD_AVAHI=OFF >/dev/null
    cmake --build build --target direwolf -- -j2 >/dev/null
    rm -f "$OUT/direwolf"   # clear any host-side dev symlink that survived COPY
    cp build/src/direwolf "$OUT/direwolf"
    echo "✓ Built decoders/packet/bin/direwolf"
    ;;
  Darwin)
    # On macOS, link the homebrew-installed direwolf into our bin/.
    BREW_BIN="$(command -v direwolf || true)"
    if [ -z "$BREW_BIN" ]; then
      echo "Install direwolf first: brew install direwolf" >&2
      exit 1
    fi
    ln -sf "$BREW_BIN" "$OUT/direwolf"
    echo "✓ Linked $BREW_BIN → decoders/packet/bin/direwolf"
    ;;
  *) echo "unsupported host $UNAME" >&2; exit 1;;
esac
