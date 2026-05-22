#!/usr/bin/env bash
# Runs inside the emscripten/emsdk container.
set -euo pipefail

SRC=$(ls ft8/*.c | tr '\n' ' ')
SRC+=" $(ls common/*.c | tr '\n' ' ')"
SRC+=" $(ls fft/*.c 2>/dev/null | tr '\n' ' ' || true)"

# wrapper.c exposes a flat C API to JS.
emcc \
  -O3 \
  -I . \
  -s ENVIRONMENT=web \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createFt8Module \
  -s EXPORTED_RUNTIME_METHODS='["cwrap","ccall","HEAP8","HEAPU8","HEAP16","HEAPU16","HEAP32","HEAPU32","HEAPF32","_malloc","_free","UTF8ToString"]' \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_ft8_decode_window","_ft8_message_count","_ft8_message_text","_ft8_message_freq","_ft8_message_snr","_ft8_message_dt","_ft8_clear"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -o ft8-decoder.js \
  $SRC wrapper.c
