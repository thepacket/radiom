// Driver: 12 kHz int16 stdin → fldigi's THOR modem → decoded chars stdout.
// THOR uses 8 kHz or 11.025 kHz internally; we resample to 8 kHz and let
// the modem retune on its own (it sets samplerate per sub-mode).

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "thor.h"
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

trx_mode thor_mode_for(const char* name) {
  if (!name) return MODE_THOR16;
  if (!std::strcmp(name, "thor4"))    return MODE_THOR4;
  if (!std::strcmp(name, "thor5"))    return MODE_THOR5;
  if (!std::strcmp(name, "thor8"))    return MODE_THOR8;
  if (!std::strcmp(name, "thor11"))   return MODE_THOR11;
  if (!std::strcmp(name, "thor16"))   return MODE_THOR16;
  if (!std::strcmp(name, "thor22"))   return MODE_THOR22;
  if (!std::strcmp(name, "thor25x4")) return MODE_THOR25x4;
  if (!std::strcmp(name, "thor50x1")) return MODE_THOR50x1;
  if (!std::strcmp(name, "thor50x2")) return MODE_THOR50x2;
  if (!std::strcmp(name, "thor100"))  return MODE_THOR100;
  if (!std::strcmp(name, "thormicro"))return MODE_THORMICRO;
  return MODE_THOR16;
}
}  // namespace


// ── TX-gen externs (defined in fldigi_glue.cpp) ────────────────────────
extern bool        g_tx_gen_active;
extern std::string g_tx_gen_text;
extern size_t      g_tx_gen_text_pos;
extern size_t      g_tx_gen_samples_written;

int main(int argc, char** argv) {
  // CLI: --mode=<thor4|5|8|11|16|22|25x4|50x1|50x2|100>  --carrier=<Hz>
  const char* modeName = "thor16";
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
  trx_mode mode = thor_mode_for(modeName);
  progdefaults.PSKsweetspot     = int(carrierHz);
  progdefaults.StartAtSweetSpot = true;

  thor* m = new thor(mode);
  modem* mm = static_cast<modem*>(m);
  active_modem = mm;
  mm->init();
  mm->set_freq(carrierHz);
  mm->rx_init();

  const double fldigiSR = mm->get_samplerate();  // 8000 or 11025

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
      std::fprintf(stderr, "[thor:gen] samples=%zu rate=%d ticks=%d\n",
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
