#!/usr/bin/env bash
# Build the Olivia/Contestia (Jalocha MFSK) decoder to WebAssembly.
#
# Outputs:
#   public/olivia-decoder.js
#   public/olivia-decoder.wasm
#
# Run: npm run build:olivia

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/olivia"
EMSCRIPTEN_IMAGE="${EMSCRIPTEN_IMAGE:-emscripten/emsdk:3.1.61}"

mkdir -p "$ROOT/public"

docker run --rm \
  -v "$SRC":/src \
  -v "$ROOT/public":/out \
  -w /src \
  "$EMSCRIPTEN_IMAGE" \
  em++ \
    -O3 -std=c++17 \
    -I . \
    -s ENVIRONMENT=web \
    -s MODULARIZE=1 \
    -s EXPORT_NAME=createOliviaModule \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAP8","HEAPU8","HEAPF64","UTF8ToString"]' \
    -s EXPORTED_FUNCTIONS='["_olivia_init","_olivia_feed","_olivia_get_text","_olivia_clear","_olivia_text_length","_malloc","_free"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=33554432 \
    -o /out/olivia-decoder.js \
    wrapper.cpp

echo "✓ Built public/olivia-decoder.{js,wasm}"
