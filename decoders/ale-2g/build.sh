#!/usr/bin/env bash
# Build the LinuxALE-vendored ALE 2G decoder.
# Output: decoders/ale-2g/bin/ale-2g-decoder
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/ale-2g"
OUT="$SRC/bin"
mkdir -p "$OUT"

CFLAGS=(
  -O2 -std=c99
  -D_GNU_SOURCE                # exposes M_PI from <math.h> on glibc
  -DNDEBUG
  -I "$SRC/stubs"
  -I "$SRC/linuxale"
  -include string.h            # vendored modem.c uses memset/strcat without including it
  -Wno-unused-result
  -Wno-deprecated-declarations
  -Wno-unused-variable
  -Wno-unused-parameter
  -Wno-implicit-function-declaration
)

SOURCES=(
  "$SRC/main.c"
  "$SRC/linuxale/modem.c"
  "$SRC/linuxale/golay.c"
)

UNAME="$(uname -s)"
case "$UNAME" in
  Linux)  CC="${CC:-gcc}";;
  Darwin) CC="${CC:-clang}";;
  *)
    docker run --rm -v "$SRC":/src -w /src debian:stable-slim \
      bash -c "apt-get update -qq && apt-get install -y -qq gcc libc6-dev > /dev/null && \
               gcc ${CFLAGS[*]} -lm -o /src/bin/ale-2g-decoder ${SOURCES[*]/$SRC/\/src}"
    exit $?
    ;;
esac

"$CC" "${CFLAGS[@]}" -o "$OUT/ale-2g-decoder" "${SOURCES[@]}" -lm
echo "✓ Built decoders/ale-2g/bin/ale-2g-decoder"
