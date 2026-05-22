#!/usr/bin/env bash
# Generate synthetic audio samples for fldigi modes that have no public
# on-air recording. Drives the vendored psk-fldigi decoder in --gen mode
# (TX path enabled, ModulateXmtr piped to stdout) and ffmpegs the raw
# int16 LE PCM into MP3.
#
# Pre-req: decoders/psk-fldigi/bin/psk-fldigi-decoder is built with the
# --gen flag wired in. ffmpeg on $PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/decoders/psk-fldigi/bin/psk-fldigi-decoder"
TEXT="${TEXT:-VVV VVV CQ CQ CQ DE RADIOM RADIOM TEST TEST 12345 67890 K}"

[[ -x "$BIN" ]] || { echo "build psk-fldigi first" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg required" >&2; exit 1; }

# mode -> output relative path (under audio/)
MODES=(
  # 8PSK
  "8psk125:psk8/8psk125.mp3"
  "8psk125fl:psk8/8psk125fl.mp3"
  "8psk125f:psk8/8psk125f.mp3"
  "8psk250:psk8/8psk250.mp3"
  "8psk250fl:psk8/8psk250fl.mp3"
  "8psk250f:psk8/8psk250f.mp3"
  "8psk500:psk8/8psk500.mp3"
  "8psk1000:psk8/8psk1000.mp3"
  "8psk1000f:psk8/8psk1000f.mp3"
  "8psk1200f:psk8/8psk1200f.mp3"
  # PSK-R
  "psk125r:psk/psk125r.mp3"
  "psk250r:psk/psk250r.mp3"
  "psk500r:psk/psk500r.mp3"
  "psk1000r:psk/psk1000r.mp3"
)

for entry in "${MODES[@]}"; do
  mode="${entry%%:*}"
  rel="${entry#*:}"
  out="$ROOT/audio/$rel"
  mkdir -p "$(dirname "$out")"

  raw="$(mktemp -t radiom-gen.XXXXXX.raw)"
  trap 'rm -f "$raw"' EXIT

  echo "── $mode → audio/$rel"
  # Run gen and capture the modem's reported sample rate from stderr.
  log="$("$BIN" --gen --mode="$mode" --text="$TEXT" 2>&1 1>"$raw")" || {
    echo "  ✗ gen failed: $log" >&2
    rm -f "$raw"
    continue
  }
  rate="$(printf '%s\n' "$log" | sed -n 's/.*rate=\([0-9]\+\).*/\1/p' | head -1)"
  rate="${rate:-8000}"
  bytes="$(wc -c < "$raw" | tr -d ' ')"
  if [[ "$bytes" -lt 1000 ]]; then
    echo "  ✗ output too small ($bytes bytes) — skipping" >&2
    rm -f "$raw"
    continue
  fi
  ffmpeg -hide_banner -loglevel error -y \
    -f s16le -ar "$rate" -ac 1 -i "$raw" \
    -codec:a libmp3lame -qscale:a 4 "$out"
  rm -f "$raw"
  echo "  ✓ $(printf '%4d KB @ %s Hz' "$(($(wc -c < "$out") / 1024))" "$rate")"
done
trap - EXIT
echo "Done."
