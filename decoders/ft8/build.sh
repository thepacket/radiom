#!/usr/bin/env bash
# Build kgoba/ft8_lib to WebAssembly via the official Emscripten Docker image.
#
# Outputs:
#   public/ft8-decoder.js
#   public/ft8-decoder.wasm
#
# Run:  npm run build:ft8

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$ROOT/decoders/ft8/.work"
LIB_REPO="https://github.com/kgoba/ft8_lib.git"
LIB_REV="${FT8_LIB_REV:-master}"
EMSCRIPTEN_IMAGE="${EMSCRIPTEN_IMAGE:-emscripten/emsdk:3.1.61}"

mkdir -p "$WORK" "$ROOT/public"

if [ ! -d "$WORK/ft8_lib" ]; then
  git clone --depth 1 "$LIB_REPO" "$WORK/ft8_lib"
  if [ "$LIB_REV" != "master" ]; then
    (cd "$WORK/ft8_lib" && git fetch origin "$LIB_REV" && git checkout "$LIB_REV")
  fi
fi

# Copy the Emscripten build wrapper into the source tree so we can invoke
# emcc from the docker container with the lib's own paths.
cp "$ROOT/decoders/ft8/wrapper.c" "$WORK/ft8_lib/wrapper.c"
cp "$ROOT/decoders/ft8/build_emcc.sh" "$WORK/ft8_lib/build_emcc.sh"
chmod +x "$WORK/ft8_lib/build_emcc.sh"

docker run --rm \
  -v "$WORK/ft8_lib":/src \
  -w /src \
  "$EMSCRIPTEN_IMAGE" \
  ./build_emcc.sh

cp "$WORK/ft8_lib/ft8-decoder.js"   "$ROOT/public/ft8-decoder.js"
cp "$WORK/ft8_lib/ft8-decoder.wasm" "$ROOT/public/ft8-decoder.wasm"

echo "✓ Built public/ft8-decoder.{js,wasm}"
