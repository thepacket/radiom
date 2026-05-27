#!/usr/bin/env bash
# Build satdump (SatDump/SatDump) headless CLI — LRPT (Meteor M2),
# HRPT (NOAA/MetOp), APT and many other weather-sat protocols.
#
# CLI-only build (no Qt/GLFW GUI, no OpenCL GPU offload). We rely on
# satdump's file/fifo baseband input — live SDR plugins are skipped
# at cmake-config time because none of librtlsdr/libairspy/etc. are
# installed in the build stage. That keeps the binary smaller and
# the apt surface narrower.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/decoders/lrpt"
OUT="$SRC/bin"
WORK="$SRC/build"
# Org moved from altillimity/SatDump → SatDump/SatDump.
SATDUMP_REF="${SATDUMP_REF:-master}"
SATDUMP_URL="${SATDUMP_URL:-https://github.com/SatDump/SatDump.git}"

mkdir -p "$OUT" "$WORK"
UNAME="$(uname -s)"
case "$UNAME" in
  Linux)
    for cmd in gcc g++ make git cmake pkgconf; do
      command -v "$cmd" >/dev/null || { echo "$cmd required" >&2; exit 1; }
    done
    cd "$WORK"
    if [ ! -d satdump ]; then
      git clone --depth 1 --branch "$SATDUMP_REF" "$SATDUMP_URL" satdump
    fi
    cd satdump
    # Upstream's CMakeLists adds `-march=native` to CXX flags only when
    # the CI env var is unset (line ~159: `if((NOT DEFINED ENV{CI})...)`).
    # On Docker BuildKit the build host has AVX2 but fly.io's Firecracker
    # CPUID lies about it → SIGILL at runtime. Setting CI=1 makes satdump
    # build for the baseline x86_64 ABI instead.
    export CI=1
    mkdir -p build && cd build
    # BUILD_GUI=OFF      : no Qt/GLFW
    # BUILD_TOOLS=OFF    : skip auxiliary tools (we just need `satdump`)
    # BUILD_OPENCL=OFF   : no GPU on fly VMs
    # BUILD_ZIQ=OFF      : skip ZIQ recording compression
    # BUILD_TESTING=OFF  : skip test harness
    # Install into a private prefix the runtime image will mirror.
    # satdump dynamically loads libsatdump_core.so AND a tree of
    # per-protocol plugins, so just copying the binary doesn't work
    # (exit 127 — ld.so can't find the core lib). The canonical
    # cmake install layout puts:
    #   bin/satdump
    #   lib/libsatdump_core.so   (+ plugins/*.so)
    #   share/satdump/...        (resources, pipelines, frequencies)
    cmake -DCMAKE_BUILD_TYPE=Release \
          -DBUILD_GUI=OFF -DBUILD_TOOLS=OFF \
          -DBUILD_OPENCL=OFF -DBUILD_ZIQ=OFF \
          -DBUILD_TESTING=OFF \
          -DCMAKE_INSTALL_PREFIX=/usr/local \
          -DCMAKE_INSTALL_LIBDIR=lib \
          ..
    make -j "$(nproc 2>/dev/null || echo 2)"
    if [ ! -x satdump ]; then
      echo "satdump build produced no binary; build tree:" >&2
      ls -la >&2
      exit 1
    fi
    make install
    # Sanity: surface where things actually landed. If satdump_core
    # ended up in /usr/local/lib/x86_64-linux-gnu (multiarch) instead
    # of /usr/local/lib, the tarball below would silently miss it.
    echo "--- satdump install inspection ---" >&2
    find /usr/local -name "libsatdump_core*" -o -name "satdump" -type f 2>/dev/null | sort >&2
    test -f /usr/local/lib/libsatdump_core.so || {
      echo "ERROR: libsatdump_core.so not at /usr/local/lib" >&2
      find /usr -name "libsatdump_core*" 2>/dev/null >&2
      exit 1
    }
    # Tarball the install tree so the Dockerfile stage can ship it
    # whole into the runtime image (preserving symlinks, modes).
    tar czf "$OUT/satdump-install.tar.gz" -C / \
        usr/local/bin/satdump \
        usr/local/lib/libsatdump_core.so \
        usr/local/lib/satdump \
        usr/local/share/satdump 2>/dev/null || true
    # Convenience: also drop the binary alone for the previous
    # COPY layout (smoke test in Dockerfile reads /out/satdump).
    cp /usr/local/bin/satdump "$OUT/satdump"
    echo "✓ Installed satdump (binary + libsatdump_core.so + plugins + resources)"
    ;;
  Darwin)
    echo "(macOS — Linux Docker stage builds satdump.)" >&2
    ;;
esac
