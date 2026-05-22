// Driver: 12 kHz int16 stdin → fldigi's DominoEX modem → decoded chars stdout.
// DominoEX uses 8 kHz internally; we resample 12k → modem's samplerate.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "dominoex.h"
#include "fl_digi.h"
#include "configuration.h"
#include "status.h"

namespace {
struct LinearResampler {
  double phase = 0.0;
  double prev  = 0.0;
  bool   primed = false;
  void process(double inRate, double outRate, const double* in, size_t n, std::vector<double>& out) {
    out.clear();
    const double step = inRate / outRate;
    for (size_t i = 0; i < n; i++) {
      const double cur = in[i];
      while (phase < 1.0) {
        const double y = primed ? prev + (cur - prev) * phase : cur;
        out.push_back(y);
        phase += step;
      }
      phase -= 1.0;
      prev   = cur;
      primed = true;
    }
  }
};

trx_mode dominoex_mode_for(const char* name) {
  if (!name) return MODE_DOMINOEX16;
  if (!std::strcmp(name, "dominoex4"))     return MODE_DOMINOEX4;
  if (!std::strcmp(name, "dominoex5"))     return MODE_DOMINOEX5;
  if (!std::strcmp(name, "dominoex8"))     return MODE_DOMINOEX8;
  if (!std::strcmp(name, "dominoex11"))    return MODE_DOMINOEX11;
  if (!std::strcmp(name, "dominoex16"))    return MODE_DOMINOEX16;
  if (!std::strcmp(name, "dominoex22"))    return MODE_DOMINOEX22;
  if (!std::strcmp(name, "dominoex44"))    return MODE_DOMINOEX44;
  if (!std::strcmp(name, "dominoex88"))    return MODE_DOMINOEX88;
  if (!std::strcmp(name, "dominoexmicro")) return MODE_DOMINOEXMICRO;
  return MODE_DOMINOEX16;
}
}  // namespace


// ── TX-gen externs (defined in fldigi_glue.cpp) ────────────────────────
extern bool        g_tx_gen_active;
extern std::string g_tx_gen_text;
extern size_t      g_tx_gen_text_pos;
extern size_t      g_tx_gen_samples_written;

int main(int argc, char** argv) {
  // CLI: --mode=<dominoex4|5|8|11|16|22|44|88>  --carrier=<Hz>
  const char* modeName = "dominoex16";
  double carrierHz = 1500.0;
  bool        gen = false;
  std::string genText;
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
        if      (std::strcmp(a, "--gen") == 0)       gen = true;
    else if (std::strncmp(a, "--text=", 7) == 0) genText = a + 7;
    else if      (std::strncmp(a, "--mode=",    7)  == 0) modeName  = a + 7;
    else if (std::strncmp(a, "--carrier=", 10) == 0) carrierHz = std::strtod(a + 10, nullptr);
  }
  if (carrierHz < 200.0)  carrierHz = 200.0;
  if (carrierHz > 3000.0) carrierHz = 3000.0;
  trx_mode mode = dominoex_mode_for(modeName);
  progdefaults.PSKsweetspot     = int(carrierHz);
  progdefaults.StartAtSweetSpot = true;

  dominoex* m = new dominoex(mode);
  modem* mm = static_cast<modem*>(m);
  active_modem = mm;
  mm->init();
  mm->set_freq(carrierHz);
  mm->rx_init();

  const double fldigiSR = mm->get_samplerate();

  static int16_t       inBuf[1024];
  std::vector<double>  in12k;  in12k.reserve(1024);
  std::vector<double>  outRs;  outRs.reserve(1024);
  LinearResampler      rs;

  
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
      std::fprintf(stderr, "[dominoex:gen] samples=%zu rate=%d ticks=%d\n",
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
    in12k.resize(n);
    for (size_t i = 0; i < n; i++) in12k[i] = double(inBuf[i]) / 32768.0;
    rs.process(12000.0, fldigiSR, in12k.data(), n, outRs);
    if (!outRs.empty()) mm->rx_process(outRs.data(), int(outRs.size()));
  }
  return 0;
}
