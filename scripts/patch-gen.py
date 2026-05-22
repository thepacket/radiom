#!/usr/bin/env python3
"""Patch each TX-intact fldigi-vendored decoder with --gen support.

Adds the same `g_tx_gen_active` / `ModulateXmtr-to-stdout` / `get_tx_char`
overrides to fldigi_glue.cpp, plus a `--gen --text=...` branch to main.cpp.

Run once after vendoring; idempotent (re-patching is a no-op).
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# decoder-dir → (modem class, modem header, ctor expression)
DECODERS = {
    'olivia-fldigi'   : ('olivia',    'olivia.h',    'new olivia(mode)'),
    'mfsk-fldigi'     : ('mfsk',      'mfsk.h',      'new mfsk(mode)'),
    'mt63-fldigi'     : ('mt63',      'mt63.h',      'new mt63(mode)'),
    'fsq-fldigi'      : ('fsq',       'fsq.h',       'new fsq(mode)'),
    'thor-fldigi'     : ('thor',      'thor.h',      'new thor(mode)'),
    'dominoex-fldigi' : ('dominoex',  'dominoex.h',  'new dominoex(mode)'),
    'contestia-fldigi': ('contestia', 'contestia.h', 'new contestia(mode)'),
    'navtex'          : ('navtex',    'navtex.h',    'new navtex(mode)'),
    'cw'              : ('cw',        'cw.h',        'new cw()'),
}

GLUE_GEN_BLOCK = """
// ── TX-gen hooks (--gen flag in main.cpp) ──────────────────────────────
// When g_tx_gen_active is true, ModulateXmtr forwards modem PCM to stdout
// as int16 LE and get_tx_char streams from g_tx_gen_text. RX builds leave
// the flag false and both behave as no-ops / NODATA.
bool        g_tx_gen_active        = false;
size_t      g_tx_gen_samples_written = 0;
std::string g_tx_gen_text;
size_t      g_tx_gen_text_pos      = 0;
"""

# Replace the no-op ModulateXmtr definition.
MODULATE_OLD = "void modem::ModulateXmtr(double*, int) {}"
MODULATE_NEW = """void modem::ModulateXmtr(double* p, int n) {
  if (!g_tx_gen_active) return;
  for (int i = 0; i < n; i++) {
    double v = p[i];
    if (v < -1.0) v = -1.0; else if (v > 1.0) v = 1.0;
    int16_t s = (int16_t)(v * 32767.0);
    std::fwrite(&s, 2, 1, stdout);
    g_tx_gen_samples_written++;
  }
}"""

# Replace the NODATA get_tx_char default.
GETCHAR_OLD = "int  get_tx_char()                          { return GET_TX_CHAR_NODATA; }"
GETCHAR_NEW = """int  get_tx_char() {
  if (!g_tx_gen_active) return GET_TX_CHAR_NODATA;
  if (g_tx_gen_text_pos >= g_tx_gen_text.size()) return GET_TX_CHAR_ETX;
  return (unsigned char)g_tx_gen_text[g_tx_gen_text_pos++];
}"""

MAIN_GEN_DECLS = """
// ── TX-gen externs (defined in fldigi_glue.cpp) ────────────────────────
extern bool        g_tx_gen_active;
extern std::string g_tx_gen_text;
extern size_t      g_tx_gen_text_pos;
extern size_t      g_tx_gen_samples_written;
"""

def patch_glue(p: Path) -> bool:
    src = p.read_text()
    if 'g_tx_gen_active' in src:
        return False  # already patched
    if MODULATE_OLD not in src:
        # Some glues use slightly different formatting — try a tolerant match.
        m = re.search(r"void modem::ModulateXmtr\(double\*,\s*int\)\s*\{\s*\}", src)
        if not m:
            print(f"  ! could not find ModulateXmtr no-op in {p}")
            return False
        src = src[:m.start()] + MODULATE_NEW + src[m.end():]
    else:
        src = src.replace(MODULATE_OLD, MODULATE_NEW)

    if GETCHAR_OLD not in src:
        m = re.search(r"int\s+get_tx_char\(\)\s*\{\s*return\s+GET_TX_CHAR_NODATA;\s*\}", src)
        if m:
            src = src[:m.start()] + GETCHAR_NEW + src[m.end():]
        else:
            print(f"  ! could not find get_tx_char no-op in {p}")
    else:
        src = src.replace(GETCHAR_OLD, GETCHAR_NEW)

    # Inject the global block right before the modem:: definitions section.
    anchor = "// modem static fields."
    if anchor in src:
        src = src.replace(anchor, GLUE_GEN_BLOCK + "\n" + anchor)
    else:
        # Fallback: prepend after the first include block.
        src = re.sub(r"(#include[^\n]+\n)(?!#include)", r"\1" + GLUE_GEN_BLOCK + "\n", src, count=1)

    p.write_text(src)
    return True

def patch_main(p: Path, modem_cls: str, modem_hdr: str, ctor: str) -> bool:
    src = p.read_text()
    if 'g_tx_gen_active' in src:
        return False  # already patched

    # Inject extern decls right before `int main(`.
    if 'int main(' not in src:
        print(f"  ! no main() in {p}")
        return False
    src = src.replace('int main(', MAIN_GEN_DECLS + '\nint main(', 1)

    # Inject argv parsing for --gen / --text= as the FIRST argument check
    # inside the for loop. Look for the first existing `if (std::strncmp(a,`.
    parse_block = (
        '    if      (std::strcmp(a, "--gen") == 0)       gen = true;\n'
        '    else if (std::strncmp(a, "--text=", 7) == 0) genText = a + 7;\n'
        '    else '
    )
    # Insert "bool gen = false; std::string genText;" right after `for (int i = 1`.
    src = re.sub(
        r"(\bfor \(int i = 1; i < argc; \+\+i\) \{\s*\n\s*const char\* a = argv\[i\];\s*\n)(\s*)(if )",
        lambda m: (
            f"{m.group(1)}{m.group(2)}{parse_block}{m.group(3)}"
        ),
        src, count=1,
    )
    # Make sure gen/genText vars are declared. Insert them just above the for loop.
    src = re.sub(
        r"(\n\s*)for \(int i = 1; i < argc; \+\+i\)",
        r"\n  bool        gen = false;\n  std::string genText;\1for (int i = 1; i < argc; ++i)",
        src, count=1,
    )

    # Inject the gen-execute block right after the modem is constructed and
    # init()'d. The pattern looks for `m->init();` or similar; we use a
    # marker comment if the file has it. Otherwise, append before the rx loop.
    gen_block = f'''
  if (gen) {{
    g_tx_gen_active   = true;
    g_tx_gen_text     = genText.empty() ? "VVV VVV CQ CQ CQ DE RADIOM RADIOM TEST TEST 12345 67890 K" : genText;
    g_tx_gen_text_pos = 0;
    if (auto* mm = dynamic_cast<modem*>(active_modem)) {{
      mm->tx_init();
      int rc = 0, ticks = 0;
      while (rc == 0 && ticks++ < 400000) rc = mm->tx_process();
      std::fflush(stdout);
      std::fprintf(stderr, "[{modem_cls}:gen] samples=%zu rate=%d ticks=%d\\n",
                   g_tx_gen_samples_written, mm->get_samplerate(), ticks);
    }}
    return 0;
  }}
'''
    # Insert the gen block right before the main RX loop (`for (;;)`).
    if 'for (;;)' in src:
        src = src.replace('for (;;)', gen_block + '\n  for (;;)', 1)
    else:
        print(f"  ! no `for (;;)` RX loop in {p}; gen block not inserted")

    p.write_text(src)
    return True

def main() -> int:
    for d, (cls, hdr, ctor) in DECODERS.items():
        glue = ROOT / 'decoders' / d / 'fldigi_glue.cpp'
        mainp = ROOT / 'decoders' / d / 'main.cpp'
        if not glue.exists():
            print(f"skip {d}: no fldigi_glue.cpp")
            continue
        if not mainp.exists():
            print(f"skip {d}: no main.cpp")
            continue
        a = patch_glue(glue)
        b = patch_main(mainp, cls, hdr, ctor)
        print(f"{d}: glue={'patched' if a else 'already'}, main={'patched' if b else 'already'}")
    return 0

if __name__ == '__main__':
    sys.exit(main())
