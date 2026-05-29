#!/usr/bin/env bash
# Build csdr (ha7ilm/csdr) — the original DSP toolkit that OpenWebRX
# was built around. Single binary `csdr` with the full `*_cf` / `*_ff`
# subcommand family (amdemod_cf, fmdemod_quadri_cf,
# bandpass_fir_fft_cc, fft_cc, logpower_cf,
# compress_fft_adpcm_f_u8, realpart_cf, fastdcblock_ff, agc_ff,
# fir_decimate_cc, convert_s16_f / convert_f_s16, shift_addition_cc,
# ...). We deliberately use this over the newer jketterl/csdr++ since
# the radiom bridge speaks the legacy command set.
#
# Upstream: https://github.com/ha7ilm/csdr
# Build deps (Debian bookworm): libfftw3-dev libsamplerate-dev make
# build-essential git ca-certificates
#
# The project uses a plain Makefile (no cmake). `make` produces
# `./csdr` and `./libcsdr.so`; `make install` drops them under
# /usr/local. We don't bother with `make install` here — the binary
# is self-contained once `libcsdr.so` is dropped into /usr/local/lib.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/src"
out="$here/bin"
mkdir -p "$out"

CSDR_REPO="https://github.com/ha7ilm/csdr.git"
CSDR_REF="master"

rm -rf "$src/csdr"
git clone --depth 1 --branch "$CSDR_REF" "$CSDR_REPO" "$src/csdr"

cd "$src/csdr"
# Some toolchains need an explicit -fcommon (ha7ilm/csdr uses
# tentative-definition tricks that gcc-10+ rejects by default).
make CFLAGS_EXTRA="-fcommon" -j"$(nproc)"

cp ./csdr "$out/csdr"
# ha7ilm/csdr's Makefile compiles libcsdr.so with an internal SONAME
# of `libcsdr.so.0.15` (set via `-Wl,-soname` at link time) but writes
# the on-disk filename as `libcsdr.so`. The csdr binary's NEEDED entry
# refers to the SONAME, so on the runtime image we must place the .so
# under the SONAME path and create a `libcsdr.so` symlink to it.
#
# Stage a tarball that, when un-tarred under /, drops:
#   /usr/local/lib/libcsdr.so.0.15  ← real .so
#   /usr/local/lib/libcsdr.so       → libcsdr.so.0.15 (symlink, for -lcsdr)
soname="$(objdump -p ./libcsdr.so 2>/dev/null | awk '/SONAME/ {print $2; exit}')"
if [ -z "$soname" ]; then soname="libcsdr.so.0.15"; fi
echo "csdr: libcsdr SONAME = $soname" >&2

stage="$src/csdr/_stage"
rm -rf "$stage"
mkdir -p "$stage/usr/local/lib"
cp ./libcsdr.so "$stage/usr/local/lib/$soname"
ln -sf "$soname" "$stage/usr/local/lib/libcsdr.so"
tar czf "$out/csdr-install.tar.gz" -C "$stage" usr

echo "csdr build OK: $out/csdr"
"$out/csdr" 2>&1 | head -5 || true
