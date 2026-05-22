// Driver: reads 12 kHz int16 PCM from stdin, resamples to 11025 Hz
// (fldigi RSID's internal samplerate), feeds the vendored cRsId
// detector. Detection events stream out on stdout as NDJSON via
// fldigi_glue.cpp's init_modem() hook.
//
// We provide a minimal RsidStubModem subclass to satisfy the modem
// pure-virtuals — rsid.cxx only ever calls get_samplerate(), get_freq(),
// and get_reverse() on the RX path, all of which return constants here.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "rsid.h"
#include "fl_digi.h"

namespace {

class RsidStubModem : public modem {
 public:
  RsidStubModem() {
    samplerate = 11025;
    frequency  = 1500.0;
    bandwidth  = 1000.0;
    mode       = 0;
  }
  void   tx_init() override   {}
  void   rx_init() override   {}
  void   restart() override   {}
  int    rx_process(const double*, int) override { return 0; }
};

struct LinearResampler {
  double phase  = 0.0;
  double prev   = 0.0;
  bool   primed = false;
  void process(double inRate, double outRate,
               const float* in, size_t n,
               std::vector<float>& out) {
    out.clear();
    const double step = inRate / outRate;
    for (size_t i = 0; i < n; i++) {
      const double cur = in[i];
      while (phase < 1.0) {
        out.push_back(float(primed ? prev + (cur - prev) * phase : cur));
        phase += step;
      }
      phase -= 1.0;
      prev   = cur;
      primed = true;
    }
  }
};

}  // namespace

int main(int /*argc*/, char** /*argv*/) {
  active_modem = new RsidStubModem();
  cRsId* rsid = new cRsId();

  static int16_t     inBuf[1024];
  std::vector<float> in12k;   in12k.reserve(1024);
  std::vector<float> outRsid; outRsid.reserve(1024);
  LinearResampler    rs;

  for (;;) {
    size_t n = std::fread(inBuf, sizeof(int16_t),
                          sizeof(inBuf) / sizeof(int16_t), stdin);
    if (n == 0) {
      if (std::feof(stdin)) break;
      continue;
    }
    in12k.resize(n);
    for (size_t i = 0; i < n; i++) in12k[i] = float(inBuf[i]) / 32768.0f;
    rs.process(12000.0, 11025.0, in12k.data(), n, outRsid);
    if (!outRsid.empty()) rsid->receive(outRsid.data(), outRsid.size());
  }
  delete rsid;
  delete active_modem;
  return 0;
}
