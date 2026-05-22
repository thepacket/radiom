// Driver: 12 kHz int16 stdin → fldigi's MFSK modem → decoded chars on stdout.
//
// MFSK's internal samplerate is 8 kHz, so we resample 12k → 8k with the
// same linear interpolator we use for the other fldigi-vendored decoders.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "mfsk.h"
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

trx_mode mfsk_mode_for(const char* name) {
  if (!name) return MODE_MFSK16;
  if (!std::strcmp(name, "mfsk4"))   return MODE_MFSK4;
  if (!std::strcmp(name, "mfsk8"))   return MODE_MFSK8;
  if (!std::strcmp(name, "mfsk11"))  return MODE_MFSK11;
  if (!std::strcmp(name, "mfsk16"))  return MODE_MFSK16;
  if (!std::strcmp(name, "mfsk22"))  return MODE_MFSK22;
  if (!std::strcmp(name, "mfsk31"))  return MODE_MFSK31;
  if (!std::strcmp(name, "mfsk32"))  return MODE_MFSK32;
  if (!std::strcmp(name, "mfsk64"))  return MODE_MFSK64;
  if (!std::strcmp(name, "mfsk128")) return MODE_MFSK128;
  return MODE_MFSK16;
}
}  // namespace


// ── TX-gen externs (defined in fldigi_glue.cpp) ────────────────────────
extern bool        g_tx_gen_active;
extern std::string g_tx_gen_text;
extern size_t      g_tx_gen_text_pos;
extern size_t      g_tx_gen_samples_written;

int main(int argc, char** argv) {
  // CLI: --mode=<mfsk4|8|11|16|22|31|32|64|128>  --pitch=<Hz>
  const char* modeName = "mfsk16";
  double pitchHz = 1500.0;
  bool        gen = false;
  std::string genText;
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
        if      (std::strcmp(a, "--gen") == 0)       gen = true;
    else if (std::strncmp(a, "--text=", 7) == 0) genText = a + 7;
    else if (std::strncmp(a, "--mode=",  7) == 0) modeName = a + 7;
    else if (std::strncmp(a, "--pitch=", 8) == 0) pitchHz = std::strtod(a + 8, nullptr);
  }
  if (pitchHz < 200.0)  pitchHz = 200.0;
  if (pitchHz > 3000.0) pitchHz = 3000.0;
  trx_mode mode = mfsk_mode_for(modeName);
  progdefaults.PSKsweetspot     = int(pitchHz);
  progdefaults.StartAtSweetSpot = true;

  mfsk* m = new mfsk(mode);
  active_modem = m;
  m->init();
  m->set_freq(pitchHz);
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
      std::fprintf(stderr, "[mfsk:gen] samples=%zu rate=%d ticks=%d\n",
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
