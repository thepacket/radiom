// Driver: 12 kHz int16 stdin → fldigi's FSQ modem → decoded chars stdout.
// FSQ's internal samplerate is 12 kHz (matches our wire rate exactly), so
// no resampling is needed — we just forward int16-as-double to rx_process.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "fsq.h"
#include "fl_digi.h"
#include "configuration.h"
#include "status.h"

namespace {
trx_mode fsq_baud_for(double baud) {
  if (baud <= 1.5)  return MODE_FSQ;     // FSQ-1.5 (default)
  if (baud <= 2.0)  return MODE_FSQ;     // FSQ doesn't have separate enums per baud
  return MODE_FSQ;
}
}  // namespace


// ── TX-gen externs (defined in fldigi_glue.cpp) ────────────────────────
extern bool        g_tx_gen_active;
extern std::string g_tx_gen_text;
extern size_t      g_tx_gen_text_pos;
extern size_t      g_tx_gen_samples_written;

int main(int argc, char** argv) {
  // CLI: --carrier=<Hz>  --baud=<1.5|2|3|4.5|6>
  double carrierHz = 1500.0;
  double baud      = 3.0;
  bool        gen = false;
  std::string genText;
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
        if      (std::strcmp(a, "--gen") == 0)       gen = true;
    else if (std::strncmp(a, "--text=", 7) == 0) genText = a + 7;
    else if      (std::strncmp(a, "--carrier=", 10) == 0) carrierHz = std::strtod(a + 10, nullptr);
    else if (std::strncmp(a, "--baud=",    7)  == 0) baud      = std::strtod(a + 7,  nullptr);
  }
  if (carrierHz < 200.0)  carrierHz = 200.0;
  if (carrierHz > 3000.0) carrierHz = 3000.0;
  progdefaults.fsqbaud = (int)(baud * 100); // fldigi stores baud×100 internally
  trx_mode mode = fsq_baud_for(baud);

  fsq* m = new fsq(mode);
  modem* mm = static_cast<modem*>(m);
  active_modem = mm;
  mm->init();
  mm->set_freq(carrierHz);
  mm->rx_init();

  static int16_t      inBuf[1024];
  std::vector<double> samples; samples.reserve(1024);

  
  if (gen) {
    g_tx_gen_active   = true;
    g_tx_gen_text     = genText.empty() ? "VVV VVV CQ CQ CQ DE RADIOM RADIOM TEST TEST 12345 67890 K" : genText;
    g_tx_gen_text_pos = 0;
    if (modem* mm = active_modem) {
      mm->tx_init();
      int rc = 0, ticks = 0;
      while (rc == 0 && ticks++ < 400000) rc = mm->tx_process();
      // Pad trailing silence so the RX-side decoder can flush its
      // interleaver/filters (esp. Olivia, MT63, PSKR FEC).
      const int sr = mm->get_samplerate();
      const int padSamples = sr * 15;  // 15 sec
      int16_t z = 0;
      for (int i = 0; i < padSamples; i++) std::fwrite(&z, 2, 1, stdout);
      std::fflush(stdout);
      std::fprintf(stderr, "[fsq:gen] samples=%zu rate=%d ticks=%d\n",
                   g_tx_gen_samples_written, mm->get_samplerate(), ticks);
    }
    return 0;
  }

  for (;;) {
    size_t n = fread(inBuf, sizeof(int16_t), sizeof(inBuf) / sizeof(int16_t), stdin);
    if (n == 0) {
      if (feof(stdin)) break;
      continue;
    }
    samples.resize(n);
    for (size_t i = 0; i < n; i++) samples[i] = double(inBuf[i]) / 32768.0;
    m->rx_process(samples.data(), int(n));
  }
  return 0;
}
