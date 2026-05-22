// Driver: 12 kHz int16 stdin → 8 kHz → fldigi's Contestia modem → stdout.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "contestia.h"
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

trx_mode contestia_mode_for(int tones, int bw) {
  struct M { int t, b; trx_mode m; };
  static const M map[] = {
    {  4,  125, MODE_CONTESTIA_4_125  },
    {  4,  250, MODE_CONTESTIA_4_250  },
    {  4,  500, MODE_CONTESTIA_4_500  },
    {  4, 1000, MODE_CONTESTIA_4_1000 },
    {  4, 2000, MODE_CONTESTIA_4_2000 },
    {  8,  125, MODE_CONTESTIA_8_125  },
    {  8,  250, MODE_CONTESTIA_8_250  },
    {  8,  500, MODE_CONTESTIA_8_500  },
    {  8, 1000, MODE_CONTESTIA_8_1000 },
    {  8, 2000, MODE_CONTESTIA_8_2000 },
    { 16,  250, MODE_CONTESTIA_16_250 },
    { 16,  500, MODE_CONTESTIA_16_500 },
    { 16, 1000, MODE_CONTESTIA_16_1000},
    { 16, 2000, MODE_CONTESTIA_16_2000},
    { 32, 1000, MODE_CONTESTIA_32_1000},
    { 32, 2000, MODE_CONTESTIA_32_2000},
    { 64,  500, MODE_CONTESTIA_64_500 },
    { 64, 1000, MODE_CONTESTIA_64_1000},
    { 64, 2000, MODE_CONTESTIA_64_2000},
  };
  for (auto& m : map) if (m.t == tones && m.b == bw) return m.m;
  return MODE_CONTESTIA;
}
}  // namespace


// ── TX-gen externs (defined in fldigi_glue.cpp) ────────────────────────
extern bool        g_tx_gen_active;
extern std::string g_tx_gen_text;
extern size_t      g_tx_gen_text_pos;
extern size_t      g_tx_gen_samples_written;

int main(int argc, char** argv) {
  // CLI: --carrier=<Hz>  --tones=<n>  --bandwidth=<Hz>
  double carrierHz = 1500.0;
  int    tones     = 8;
  int    bw        = 250;
  bool        gen = false;
  std::string genText;
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
        if      (std::strcmp(a, "--gen") == 0)       gen = true;
    else if (std::strncmp(a, "--text=", 7) == 0) genText = a + 7;
    else if      (std::strncmp(a, "--carrier=",   10) == 0) carrierHz = std::strtod(a + 10, nullptr);
    else if (std::strncmp(a, "--tones=",      8) == 0) tones = std::atoi(a + 8);
    else if (std::strncmp(a, "--bandwidth=", 12) == 0) bw    = std::atoi(a + 12);
    else if (std::strncmp(a, "--smargin=",   10) == 0) progdefaults.contestiasmargin = std::atoi(a + 10);
    else if (std::strncmp(a, "--sinteg=",     9) == 0) progdefaults.contestiasinteg  = std::atoi(a +  9);
  }
  if (carrierHz < 200.0)  carrierHz = 200.0;
  if (carrierHz > 3000.0) carrierHz = 3000.0;

  trx_mode m = contestia_mode_for(tones, bw);
  progdefaults.StartAtSweetSpot = false;

  contestia* modem_ct = new contestia(m);
  active_modem = modem_ct;
  modem_ct->init();
  modem_ct->set_freq(carrierHz);
  modem_ct->rx_init();

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
      std::fprintf(stderr, "[contestia:gen] samples=%zu rate=%d ticks=%d\n",
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
    if (!out8k.empty()) modem_ct->rx_process(out8k.data(), int(out8k.size()));
  }
  return 0;
}
