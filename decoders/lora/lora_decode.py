#!/usr/bin/env python3
"""LoRa single-channel decoder driver for radiom's bridge.

Reads CS16 (int16 LE interleaved I/Q) samples from stdin, runs
gr-lora_sdr's standard receive flowgraph, prints one decoded packet
per line as a JSON object on stdout. Status / errors go to stderr.

Args (sensible defaults match LoRaWAN EU/US public traffic):
  --bw    {125000,250000,500000}   channel bandwidth, Hz
  --sf    {7..12}                  spreading factor
  --cr    {1..4}                   coding rate (4/5..4/8 → 1..4)
  --rate  Hz                       input sample rate (must be ≥ 2*BW)
  --has-crc 0/1                    LoRaWAN-style CRC present (1=yes)
  --impl-header 0/1                explicit header (0) or implicit (1)

The script is intentionally minimal — gr-lora_sdr ships much richer
example flowgraphs (multi-channel, sniffer, etc.) but we only need
single-channel decode driven by the rtl_tcp bridge's IQ stream.
"""
import argparse
import json
import sys

try:
    from gnuradio import gr, blocks  # type: ignore
    from gnuradio.lora_sdr import lora_rx  # type: ignore
except Exception as e:  # pragma: no cover - runtime path
    sys.stderr.write(f"gr-lora_sdr import failed: {e}\n")
    sys.stderr.write("Ensure gnuradio + gr-lora_sdr installed (npm run build:lora).\n")
    sys.exit(1)


def build_top(rate: int, bw: int, sf: int, cr: int, has_crc: int, impl_header: int):
    tb = gr.top_block("radiom-lora-rx", catch_exceptions=True)

    # Stdin → interleaved int16 → complex (vector_interpret + short→complex)
    src = blocks.file_descriptor_source(gr.sizeof_short, 0, False)  # fd=0 (stdin)
    s2cs = blocks.interleaved_short_to_complex(False, False, 1.0 / 32768.0)
    rx = lora_rx(
        bw=bw, cr=cr, has_crc=bool(has_crc), impl_head=bool(impl_header),
        pay_len=255, samp_rate=rate, sf=sf, sync_word=[0x12], soft_decoding=True,
        ldro_mode=2, print_rx=[False, False],
    )
    # Sink: rx emits a tagged stream + a "out" message port carrying the
    # decoded payload + CRC status. The simplest robust path is to attach
    # a `message_debug` sink and let it print to stdout.
    msink = blocks.message_debug()
    tb.connect(src, s2cs, rx)
    tb.msg_connect((rx, 'out'), (msink, 'print_pdu'))
    return tb


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--bw', type=int, default=125_000)
    ap.add_argument('--sf', type=int, default=7)
    ap.add_argument('--cr', type=int, default=1)
    ap.add_argument('--rate', type=int, default=500_000)
    ap.add_argument('--has-crc', type=int, default=1)
    ap.add_argument('--impl-header', type=int, default=0)
    args = ap.parse_args()

    if args.rate < 2 * args.bw:
        sys.stderr.write(
            f"sample rate {args.rate} < 2× BW {args.bw}; bumping to {2 * args.bw}\n"
        )
        args.rate = 2 * args.bw

    sys.stderr.write(
        f"lora_decode start: bw={args.bw} sf={args.sf} cr=4/{4+args.cr} "
        f"rate={args.rate} has_crc={args.has_crc} impl_header={args.impl_header}\n"
    )
    tb = build_top(args.rate, args.bw, args.sf, args.cr,
                   args.has_crc, args.impl_header)
    try:
        tb.start()
        tb.wait()
    except KeyboardInterrupt:
        tb.stop(); tb.wait()
    return 0


if __name__ == '__main__':
    sys.exit(main())
