// Driver: reads 12 kHz int16 PCM from stdin, resamples to 11025 Hz
// (fldigi navtex's internal samplerate, set in the constructor), and
// feeds the vendored fldigi navtex modem. Decoded characters land on
// stdout via put_rx_char() in fldigi_glue.cpp.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "navtex.h"
#include "fl_digi.h"
#include "configuration.h"
#include "status.h"

namespace {
struct LinearResampler {
  double phase  = 0.0;
  double prev   = 0.0;
  bool   primed = false;
  void process(double inRate, double outRate,
               const double* in, size_t n,
               std::vector<double>& out) {
    out.clear();
    const double step = inRate / outRate;
    for (size_t i = 0; i < n; i++) {
      const double cur = in[i];
      while (phase < 1.0) {
        out.push_back(primed ? prev + (cur - prev) * phase : cur);
        phase += step;
      }
      phase -= 1.0;
      prev   = cur;
      primed = true;
    }
  }
};
}  // namespace


// ── TX-gen externs (defined in fldigi_glue.cpp) ────────────────────────
extern bool        g_tx_gen_active;
extern std::string g_tx_gen_text;
extern size_t      g_tx_gen_text_pos;
extern size_t      g_tx_gen_samples_written;

int main(int argc, char** argv) {
  // CLI: --mode=<navtex|sitorb>  --carrier=<Hz>
  trx_mode mode = MODE_NAVTEX;
  double carrierHz = 1900.0;
  bool        gen = false;
  std::string genText;
  for (int i = 1; i < argc; ++i) {
    if      (std::strcmp(argv[i], "--gen") == 0) gen = true;
    else if (std::strncmp(argv[i], "--text=", 7) == 0) genText = argv[i] + 7;
    else if (std::strcmp(argv[i], "--mode=sitorb") == 0) mode = MODE_SITORB;
    else if (std::strcmp(argv[i], "--mode=navtex") == 0) mode = MODE_NAVTEX;
    else if (std::strncmp(argv[i], "--carrier=", 10) == 0) carrierHz = std::strtod(argv[i] + 10, nullptr);
  }
  if (carrierHz < 500.0)  carrierHz = 500.0;
  if (carrierHz > 3000.0) carrierHz = 3000.0;

  navtex* nx = new navtex(mode);
  active_modem = static_cast<modem*>(nx);
  nx->init();
  nx->rx_init();
  nx->set_freq(carrierHz);

  // navtex sets modem::samplerate = 11025 in its constructor.
  const double FAX_SR = 11025.0;

  static int16_t      inBuf[1024];
  std::vector<double> in12k;  in12k.reserve(1024);
  std::vector<double> outRs;  outRs.reserve(1024);
  LinearResampler     rs;

  
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
      std::fprintf(stderr, "[navtex:gen] samples=%zu rate=%d ticks=%d\n",
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
    rs.process(12000.0, FAX_SR, in12k.data(), n, outRs);
    // navtex::rx_process doesn't gate on len, but for parity with the
    // wefax driver (and to be defensive against any internal limit) we
    // still chunk in ≤512-sample blocks.
    if (!outRs.empty()) {
      constexpr size_t CHUNK = 512;
      for (size_t off = 0; off < outRs.size(); off += CHUNK) {
        const size_t take = std::min(CHUNK, outRs.size() - off);
        nx->rx_process(outRs.data() + off, int(take));
      }
    }
  }
  return 0;
}
