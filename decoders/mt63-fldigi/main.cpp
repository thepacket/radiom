// Driver: 12 kHz int16 stdin → fldigi's MT63 modem → decoded chars stdout.
// MT63's internal samplerate is 8 kHz; we resample 12k → 8k.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "mt63.h"
#include "fl_digi.h"
#include "configuration.h"
#include "status.h"

namespace {
struct LinearResampler {
  double phase = 0.0;
  double prev  = 0.0;
  bool   primed = false;
  template <int IN_RATE, int OUT_RATE>
  size_t process(const double* in, size_t n, std::vector<double>& out) {
    out.clear();
    const double step = double(IN_RATE) / double(OUT_RATE);
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
    return out.size();
  }
};

trx_mode mt63_mode_for(const char* name) {
  if (!name) return MODE_MT63_1000L;
  if (!std::strcmp(name, "500s"))  return MODE_MT63_500S;
  if (!std::strcmp(name, "500l"))  return MODE_MT63_500L;
  if (!std::strcmp(name, "1000s")) return MODE_MT63_1000S;
  if (!std::strcmp(name, "1000l")) return MODE_MT63_1000L;
  if (!std::strcmp(name, "2000s")) return MODE_MT63_2000S;
  if (!std::strcmp(name, "2000l")) return MODE_MT63_2000L;
  return MODE_MT63_1000L;
}
}  // namespace


// ── TX-gen externs (defined in fldigi_glue.cpp) ────────────────────────
extern bool        g_tx_gen_active;
extern std::string g_tx_gen_text;
extern size_t      g_tx_gen_text_pos;
extern size_t      g_tx_gen_samples_written;

int main(int argc, char** argv) {
  // CLI: --mode=<500s|500l|1000s|1000l|2000s|2000l>  --carrier=<Hz>
  // --integration=<short|long>  --8bit=<0|1>
  const char* modeName = "1000l";
  double carrierHz = 1500.0;
  bool        gen = false;
  std::string genText;
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
        if      (std::strcmp(a, "--gen") == 0)       gen = true;
    else if (std::strncmp(a, "--text=", 7) == 0) genText = a + 7;
    else if      (std::strncmp(a, "--mode=",        7) == 0) modeName  = a + 7;
    else if (std::strncmp(a, "--carrier=",    10) == 0) carrierHz = std::strtod(a + 10, nullptr);
    else if (std::strncmp(a, "--integration=",14) == 0) progdefaults.mt63_rx_integration = (std::strcmp(a + 14, "long") == 0);
    else if (std::strncmp(a, "--8bit=",        7) == 0) progdefaults.mt63_8bit = (std::atoi(a + 7) != 0);
  }
  if (carrierHz < 500.0)  carrierHz = 500.0;
  if (carrierHz > 3000.0) carrierHz = 3000.0;
  trx_mode mode = mt63_mode_for(modeName);
  // Honour the explicit carrier we set below, not the at500/centered presets.
  progdefaults.mt63_at500    = false;
  progdefaults.mt63_centered = false;

  mt63* m = new mt63(mode);
  active_modem = m;
  m->init();
  m->set_freq(carrierHz);
  m->rx_init();

  static int16_t       inBuf[1024];
  std::vector<double>  in12k;  in12k.reserve(1024);
  std::vector<double>  out8k;  out8k.reserve(1024);
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
      std::fprintf(stderr, "[mt63:gen] samples=%zu rate=%d ticks=%d\n",
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
    rs.process<12000, 8000>(in12k.data(), n, out8k);
    if (!out8k.empty()) m->rx_process(out8k.data(), int(out8k.size()));
  }
  return 0;
}
