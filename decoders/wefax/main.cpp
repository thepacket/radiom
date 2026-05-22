// Driver: reads 12 kHz int16 PCM from stdin, resamples to 11025 Hz
// (fldigi wefax's internal samplerate — see modem::samplerate set in
// wefax::wefax()), feeds the vendored fldigi wefax modem, and lets
// wefax_pic::update_rx_pic_bw() flush row events to stdout via
// fldigi_glue.cpp.
//
// All decoding (FM demod, APT detection, phasing lock, line-clock
// recovery, slant correction) happens inside fldigi's wefax.cxx
// unmodified. We only adapt sample rate at the input edge.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "wefax.h"
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

int main(int argc, char** argv) {
  // CLI: --lpm=<60|90|120|240>  --filter=<narrow|medium|wide>
  int  lpm    = 120;
  int  filter = 0;
  // Default to manual mode. fldigi's APT + phasing detectors have hard
  // amplitude thresholds (x>200 / x<25 of 255) that AGC-flattened Kiwi
  // audio rarely satisfies, so they never lock. Manual mode skips both
  // detectors and streams pixels continuously; the operator clicks any
  // column on the canvas to set the line origin (handled client-side).
  // After WEFAX_MaxRows lines (≈ 2300 = 19 min at 120 LPM) fldigi auto-
  // cycles, calling skip_apt + skip_phasing internally, so reception
  // continues uninterrupted across multiple charts.
  bool manual  = true;
  bool skipApt = false;
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
    if      (std::strncmp(a, "--lpm=", 6)    == 0) lpm = std::atoi(a + 6);
    else if (std::strncmp(a, "--filter=", 9) == 0) filter = std::atoi(a + 9);
    else if (std::strcmp (a, "--auto")        == 0) { manual = false; skipApt = false; }
    else if (std::strcmp (a, "--manual")      == 0) { manual = true;  skipApt = false; }
    else if (std::strcmp (a, "--skip-apt")    == 0) { manual = false; skipApt = true;  }
  }
  if (lpm != 60 && lpm != 90 && lpm != 120 && lpm != 240) lpm = 120;
  if (filter < 0 || filter > 2) filter = 0;
  progdefaults.wefax_filter = filter;

  wefax* fax = new wefax(MODE_WEFAX_576);  // IOC576 — the standard.
  active_modem = static_cast<modem*>(fax);
  fax->init();
  fax->rx_init();
  fax->set_lpm(lpm);
  // Default to manual mode: fldigi otherwise waits for the APT start
  // tone (which only fires at the beginning of a fresh chart broadcast).
  // In manual mode, decoded pixels stream immediately and the user can
  // align the image via click-on-canvas.
  fax->set_rx_manual_mode(manual);
  if (skipApt) fax->skip_apt();

  // wefax::wefax() sets modem::samplerate = 11025 internally; we hardcode
  // the same value here since `samplerate` is a protected member.
  const double FAX_SR = 11025.0;

  static int16_t      inBuf[1024];
  std::vector<double> in12k;  in12k.reserve(1024);
  std::vector<double> outFax; outFax.reserve(1024);
  LinearResampler     rs;

  for (;;) {
    size_t n = fread(inBuf, sizeof(int16_t), sizeof(inBuf) / sizeof(int16_t), stdin);
    if (n == 0) {
      if (feof(stdin)) break;
      continue;
    }
    in12k.resize(n);
    for (size_t i = 0; i < n; i++) in12k[i] = double(inBuf[i]) / 32768.0;
    rs.process(12000.0, FAX_SR, in12k.data(), n, outFax);
    // wefax::rx_process drops any buffer larger than 512 samples
    // outright (len > 512 → return 0). Chunk the resampled audio so
    // every call lands inside the limit.
    constexpr size_t CHUNK = 512;
    for (size_t off = 0; off < outFax.size(); off += CHUNK) {
      const size_t take = std::min(CHUNK, outFax.size() - off);
      fax->rx_process(outFax.data() + off, int(take));
    }
  }
  return 0;
}
