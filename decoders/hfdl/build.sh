#!/usr/bin/env bash
# Build the dumphfdl-vendored HFDL decoder.
#
# Unlike the fldigi/LinuxALE-vendored decoders (where source lives under
# decoders/<name>/), dumphfdl is a self-contained CMake project with
# build-time dependencies on libacars + liquid-dsp + fftw3 + glib2 +
# libconfig++. We don't vendor those — the Dockerfile stage clones
# pinned upstream versions and builds them. Local builds shell out to
# Docker; macOS dependency setup isn't worth scripting.
#
# Output: decoders/hfdl/bin/hfdl-decoder (a thin wrapper that exec's
# the real dumphfdl with our standard CLI). Also installs the dumphfdl
# binary itself + libacars.so to that directory, so the wrapper can
# find them via LD_LIBRARY_PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/hfdl"
OUT="$SRC/bin"
mkdir -p "$OUT"

# Pinned upstream versions — bump deliberately when a security fix or
# protocol change lands. dumphfdl + libacars are by the same author
# (szpajder) and version-locked.
DUMPHFDL_VERSION="${DUMPHFDL_VERSION:-v1.7.0}"
LIBACARS_VERSION="${LIBACARS_VERSION:-v2.2.1}"

UNAME="$(uname -s)"
if [ "$UNAME" != "Linux" ]; then
  # On macOS / unknown: shell into Docker, mount the project dir,
  # build there. The output binary is a Linux ELF — only ever runs in
  # the production container — so a native Darwin build is pointless.
  echo "→ non-Linux host detected; building dumphfdl in a Debian container"
  docker run --rm \
    -v "$SRC":/out \
    -e DUMPHFDL_VERSION="$DUMPHFDL_VERSION" \
    -e LIBACARS_VERSION="$LIBACARS_VERSION" \
    debian:bookworm-slim bash -c "
      set -euo pipefail
      apt-get update -qq
      apt-get install -y -qq --no-install-recommends \
        build-essential cmake pkg-config git ca-certificates \
        libglib2.0-dev libconfig++-dev libliquid-dev \
        libfftw3-dev zlib1g-dev libxml2-dev libsqlite3-dev \
        > /dev/null
      cd /tmp
      git clone --depth 1 --branch '$LIBACARS_VERSION' https://github.com/szpajder/libacars.git
      cd libacars && mkdir build && cd build
      cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .. > /dev/null
      make -j\$(nproc) > /dev/null && make install > /dev/null
      cd /tmp
      git clone --depth 1 --branch '$DUMPHFDL_VERSION' https://github.com/szpajder/dumphfdl.git
      cd dumphfdl && mkdir build && cd build
      cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .. > /dev/null
      make -j\$(nproc) > /dev/null && make install > /dev/null
      ldconfig
      mkdir -p /out/bin
      cp /usr/local/bin/dumphfdl /out/bin/dumphfdl
      cp -P /usr/local/lib/libacars-2.so* /out/bin/
      strip /out/bin/dumphfdl /out/bin/libacars-2.so* || true
      echo '✓ dumphfdl + libacars copied to /out/bin'
    "
  echo "✓ Built decoders/hfdl/bin/dumphfdl (Linux ELF, will run in container)"
  exit 0
fi

# Linux native build path — used by the Dockerfile stage.
WORK="$(mktemp -d)"
trap "rm -rf $WORK" EXIT

cd "$WORK"
echo "→ Building libacars $LIBACARS_VERSION"
git clone --depth 1 --branch "$LIBACARS_VERSION" https://github.com/szpajder/libacars.git
cd libacars && mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .. >/dev/null
make -j"$(nproc)" >/dev/null && make install >/dev/null

cd "$WORK"
echo "→ Building dumphfdl $DUMPHFDL_VERSION"
git clone --depth 1 --branch "$DUMPHFDL_VERSION" https://github.com/szpajder/dumphfdl.git
cd dumphfdl && mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .. >/dev/null
make -j"$(nproc)" >/dev/null && make install >/dev/null

ldconfig 2>/dev/null || true
cp /usr/local/bin/dumphfdl "$OUT/dumphfdl"
cp -P /usr/local/lib/libacars-2.so* "$OUT/"
strip "$OUT/dumphfdl" "$OUT"/libacars-2.so* 2>/dev/null || true
echo "✓ Built decoders/hfdl/bin/dumphfdl"
