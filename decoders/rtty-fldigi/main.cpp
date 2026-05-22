// Driver: 12 kHz int16 stdin → fldigi's RTTY modem → decoded chars stdout.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "rtty.h"
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
}  // namespace

int main(int argc, char** argv) {
  // CLI: --carrier=<Hz>  --baud=<45.45|50|75|100>  --shift=<170|85|450|850>
  // --bits=<5|7|8>  --parity=<none|odd|even|zero|one>  --stop=<1|1.5|2>
  double carrierHz = 1500.0;
  double baud      = 45.45;
  double shift     = 170.0;
  int    bits      = 5;     // 0=5, 1=7, 2=8 (fldigi enum)
  int    parity    = 0;     // 0=none
  int    stopIdx   = 1;     // 0=1.0, 1=1.5, 2=2.0
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
    if      (std::strncmp(a, "--carrier=", 10) == 0) carrierHz = std::strtod(a + 10, nullptr);
    else if (std::strncmp(a, "--baud=",     7) == 0) baud      = std::strtod(a + 7,  nullptr);
    else if (std::strncmp(a, "--shift=",    8) == 0) shift     = std::strtod(a + 8,  nullptr);
    else if (std::strncmp(a, "--bits=",     7) == 0) {
      int b = std::atoi(a + 7);
      bits = (b == 5) ? 0 : (b == 7) ? 1 : (b == 8) ? 2 : 0;
    }
    else if (std::strncmp(a, "--stop=",     7) == 0) {
      double s = std::strtod(a + 7, nullptr);
      stopIdx = (s <= 1.0) ? 0 : (s <= 1.5) ? 1 : 2;
    }
  }
  if (carrierHz < 200.0)  carrierHz = 200.0;
  if (carrierHz > 3000.0) carrierHz = 3000.0;

  // Push CLI knobs into progdefaults so rtty.cxx picks them up at construct.
  // fldigi stores rtty_baud and rtty_shift as INDICES into lookup tables
  // (BAUD[] and SHIFT[] in rtty.cxx), not raw values. Map our CLI args
  // accordingly. For non-standard shifts, fall back to rtty_custom_shift.
  progdefaults.RTTYsweetspot     = int(carrierHz);
  progdefaults.StartAtSweetSpot  = true;
  // BAUD[] = {45, 45.45, 50, 56, 75, 100, 110, 150, 200, 300}
  static const struct { double v; int idx; } BAUD_MAP[] = {
    {45,0},{45.45,1},{50,2},{56,3},{75,4},{100,5},{110,6},{150,7},{200,8},{300,9}
  };
  int baudIdx = 1;  // default 45.45
  for (auto& m : BAUD_MAP) if (std::fabs(m.v - baud) < 0.01) { baudIdx = m.idx; break; }
  progdefaults.rtty_baud = baudIdx;
  // SHIFT[] = {23, 85, 160, 170, 182, 200, 240, 350, 425, 850}
  static const struct { double v; int idx; } SHIFT_MAP[] = {
    {23,0},{85,1},{160,2},{170,3},{182,4},{200,5},{240,6},{350,7},{425,8},{850,9}
  };
  int shiftIdx = -1;
  for (auto& m : SHIFT_MAP) if (std::fabs(m.v - shift) < 0.01) { shiftIdx = m.idx; break; }
  if (shiftIdx >= 0) {
    progdefaults.rtty_shift = shiftIdx;
  } else {
    // Out-of-table shift → use custom path. numshifts (in rtty.cxx) is
    // the size of SHIFT[]; passing rtty_shift >= numshifts triggers the
    // custom_shift fallback.
    progdefaults.rtty_shift        = 99;            // any index ≥ numshifts
    progdefaults.rtty_custom_shift = shift;
  }
  progdefaults.rtty_bits         = bits;
  progdefaults.rtty_parity       = parity;
  progdefaults.rtty_stop         = stopIdx;

  rtty* m = new rtty(MODE_RTTY);
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
