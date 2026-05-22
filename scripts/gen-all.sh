#!/usr/bin/env bash
# Run --gen across every fldigi decoder + variant we have, encoding the raw
# int16 LE PCM output to MP3 (8 kHz mono unless the decoder reports another
# rate via stderr).
#
# Skips decoders whose tx_process() is stubbed (i.e. ports that did RX-only
# vendoring without re-pulling the upstream TX path).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEXT="${TEXT:-VVV VVV CQ CQ CQ DE RADIOM RADIOM TEST TEST 12345 67890 K}"
OUT_BASE="$ROOT/audio"

command -v ffmpeg >/dev/null || { echo "ffmpeg required" >&2; exit 1; }

run_gen() {  # bin, args, out_path
  local bin="$1" args="$2" out="$3"
  mkdir -p "$(dirname "$out")"
  local raw
  raw="$(mktemp -t radiom-gen.XXXXXX.raw)"
  local err rate bytes
  err="$(eval "$bin --gen $args --text=\"\$TEXT\"" 2>&1 1>"$raw" || true)"
  rate=$(printf '%s\n' "$err" | sed -nE 's/.*rate=([0-9]+).*/\1/p' | head -1)
  rate="${rate:-8000}"
  bytes=$(wc -c < "$raw" | tr -d ' ')
  if [[ "$bytes" -lt 1500 ]]; then
    echo "  ✗ $(basename "$out"): too small ($bytes bytes) — $err" >&2
    rm -f "$raw"
    return 1
  fi
  ffmpeg -hide_banner -loglevel error -y -f s16le -ar "$rate" -ac 1 -i "$raw" \
         -codec:a libmp3lame -qscale:a 4 "$out"
  rm -f "$raw"
  printf '  ✓ %-44s %4d KB @ %s Hz\n' "$(basename "$out")" "$(($(wc -c < "$out") / 1024))" "$rate"
}

# ── PSK (already done by gen-samples.sh; rerun for consistency) ────────
PSK_BIN="$ROOT/decoders/psk-fldigi/bin/psk-fldigi-decoder"
echo "## PSK family"
for spec in \
  "bpsk31:psk/bpsk31_gen.mp3" \
  "bpsk63:psk/bpsk63_gen.mp3" \
  "bpsk63f:psk/bpsk63f_gen.mp3" \
  "bpsk125:psk/bpsk125_gen.mp3" \
  "bpsk250:psk/bpsk250_gen.mp3" \
  "bpsk500:psk/bpsk500_gen.mp3" \
  "bpsk1000:psk/bpsk1000_gen.mp3" \
  "qpsk31:qpsk/qpsk31_gen.mp3" \
  "qpsk63:qpsk/qpsk63_gen.mp3" \
  "qpsk125:qpsk/qpsk125_gen.mp3" \
  "qpsk250:qpsk/qpsk250_gen.mp3" \
  "qpsk500:qpsk/qpsk500_gen.mp3"; do
  m="${spec%%:*}"; o="$OUT_BASE/${spec#*:}"
  run_gen "$PSK_BIN" "--mode=$m" "$o" || true
done

# ── Olivia (18 variants) ──────────────────────────────────────────────
OL_BIN="$ROOT/decoders/olivia-fldigi/bin/olivia-fldigi-decoder"
echo "## Olivia"
for spec in \
  "4 125" "4 250" "4 500" "4 1000" "4 2000" \
  "8 125" "8 250" "8 500" "8 1000" "8 2000" \
  "16 500" "16 1000" "16 2000" \
  "32 1000" "32 2000" \
  "64 500" "64 1000" "64 2000"; do
  read -r t bw <<<"$spec"
  bwlbl=$bw; [[ $bw -ge 1000 ]] && bwlbl="$((bw/1000))k"
  out="$OUT_BASE/olivia/olivia_${t}_${bw}_gen.mp3"
  run_gen "$OL_BIN" "--tones=$t --bandwidth=$bw" "$out" || true
done

# ── Contestia (19 variants) ───────────────────────────────────────────
CT_BIN="$ROOT/decoders/contestia-fldigi/bin/contestia-fldigi-decoder"
echo "## Contestia"
for spec in \
  "4 125" "4 250" "4 500" "4 1000" "4 2000" \
  "8 125" "8 250" "8 500" "8 1000" "8 2000" \
  "16 250" "16 500" "16 1000" "16 2000" \
  "32 1000" "32 2000" \
  "64 500" "64 1000" "64 2000"; do
  read -r t bw <<<"$spec"
  out="$OUT_BASE/contestia/contestia_${t}_${bw}_gen.mp3"
  run_gen "$CT_BIN" "--tones=$t --bandwidth=$bw" "$out" || true
done

# ── MFSK (12 variants) ────────────────────────────────────────────────
MF_BIN="$ROOT/decoders/mfsk-fldigi/bin/mfsk-fldigi-decoder"
echo "## MFSK"
for m in mfsk4 mfsk8 mfsk11 mfsk16 mfsk22 mfsk31 mfsk32 mfsk64 mfsk128; do
  run_gen "$MF_BIN" "--mode=$m" "$OUT_BASE/mfsk/${m}_gen.mp3" || true
done

# ── MT63 (6 variants) ─────────────────────────────────────────────────
MT_BIN="$ROOT/decoders/mt63-fldigi/bin/mt63-fldigi-decoder"
echo "## MT63"
for m in 500s 500l 1000s 1000l 2000s 2000l; do
  run_gen "$MT_BIN" "--mode=$m" "$OUT_BASE/mt63/mt63_${m}_gen.mp3" || true
done

# ── NAVTEX + SITOR-B ──────────────────────────────────────────────────
NX_BIN="$ROOT/decoders/navtex/bin/navtex-decoder"
echo "## NAVTEX"
run_gen "$NX_BIN" "--mode=navtex" "$OUT_BASE/navtex/navtex_gen.mp3" || true
run_gen "$NX_BIN" "--mode=sitorb" "$OUT_BASE/navtex/sitorb_gen.mp3" || true

echo
echo "Done."
