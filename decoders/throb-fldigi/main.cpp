// Driver: 12 kHz int16 stdin → fldigi's throb modem → decoded chars
// on stdout.
//
// Submodes (--mode=…):
//   throb1, throb2, throb4   — base Throb (no FEC)
//   throbx1, throbx2, throbx4 — ThrobX (with inner FEC)
//
// All variants run at 8 kHz internally so we resample 12k → 8k with
// the same linear interpolator used by the other fldigi-vendored
// decoders.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "throb.h"
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

trx_mode throb_mode_for(const char* name) {
  if (!name) return MODE_THROB1;
  if (!std::strcmp(name, "throb1"))  return MODE_THROB1;
  if (!std::strcmp(name, "throb2"))  return MODE_THROB2;
  if (!std::strcmp(name, "throb4"))  return MODE_THROB4;
  if (!std::strcmp(name, "throbx1")) return MODE_THROBX1;
  if (!std::strcmp(name, "throbx2")) return MODE_THROBX2;
  if (!std::strcmp(name, "throbx4")) return MODE_THROBX4;
  return MODE_THROB1;
}
}  // namespace

int main(int argc, char** argv) {
  const char* modeName = "throb1";
  double pitchHz = 1000.0;
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
    if      (std::strncmp(a, "--mode=",  7) == 0) modeName = a + 7;
    else if (std::strncmp(a, "--pitch=", 8) == 0) pitchHz = std::strtod(a + 8, nullptr);
  }
  if (pitchHz < 200.0)  pitchHz = 200.0;
  if (pitchHz > 3000.0) pitchHz = 3000.0;
  trx_mode mode = throb_mode_for(modeName);
  progdefaults.PSKsweetspot     = int(pitchHz);
  progdefaults.StartAtSweetSpot = true;

  throb* m = new throb(mode);
  active_modem = m;
  m->init();
  m->set_freq(pitchHz);
  m->rx_init();

  static int16_t       inBuf[1024];
  std::vector<double>  in12k;  in12k.reserve(1024);
  std::vector<double>  out8k;  out8k.reserve(1024);
  LinearResampler      rs;

  for (;;) {
    size_t n = std::fread(inBuf, sizeof(int16_t), sizeof(inBuf) / sizeof(int16_t), stdin);
    if (n == 0) {
      if (std::feof(stdin)) break;
      continue;
    }
    in12k.resize(n);
    for (size_t i = 0; i < n; i++) in12k[i] = double(inBuf[i]) / 32768.0;
    rs.process<12000, 8000>(in12k.data(), n, out8k);
    if (!out8k.empty()) m->rx_process(out8k.data(), int(out8k.size()));
  }
  return 0;
}
