// Minimal driver: reads 12 kHz int16 PCM from stdin, resamples to 8 kHz
// (fldigi's internal CW_SAMPLERATE), feeds the vendored fldigi cw modem,
// lets put_rx_char() flush characters to stdout.
//
// All decoding happens inside the fldigi sources in decoders/cw/fldigi/.
// We do NOT modify fldigi's source — the rate adapter lives only here.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "cw.h"
#include "fl_digi.h"
#include "configuration.h"
#include "status.h"

namespace {
// Linear-interpolation resampler from `inRate` Hz → `outRate` Hz. Linear
// is fine here: the audio is already band-limited to ≤4 kHz by the SSB
// upstream, well below the 4 kHz Nyquist of the 8 kHz output, so the
// aliasing risk is minimal and fldigi's own bandpass filters clean up
// what's left.
struct LinearResampler {
  double phase = 0.0;        // fractional input-sample position
  double prev  = 0.0;        // last input sample (for interpolation across calls)
  bool   primed = false;
  // Process `n` input samples → push 8 kHz samples into `out`.
  // Returns how many output samples were produced.
  template <int IN_RATE, int OUT_RATE>
  size_t process(const double* in, size_t n, std::vector<double>& out) {
    out.clear();
    const double step = double(IN_RATE) / double(OUT_RATE);  // 12000/8000 = 1.5
    for (size_t i = 0; i < n; i++) {
      const double cur = in[i];
      // Emit every output sample whose time index falls inside (prev, cur].
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
}  // namespace


// ── TX-gen externs (defined in fldigi_glue.cpp) ────────────────────────
extern bool        g_tx_gen_active;
extern std::string g_tx_gen_text;
extern size_t      g_tx_gen_text_pos;
extern size_t      g_tx_gen_samples_written;

int main(int argc, char** argv) {
  // CLI flags map onto fldigi's progdefaults so cw.cxx picks them up at
  // construction. Anything not specified keeps the default in
  // configuration.h (which itself matches fldigi's out-of-the-box config).
  double pitchHz = 800.0;
  int    wpm     = 18;
  bool        gen = false;
  std::string genText;
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
    auto match_d = [&](const char* prefix, double& out) {
      size_t n = std::strlen(prefix);
      if (std::strncmp(a, prefix, n) == 0) { out = std::strtod(a + n, nullptr); return true; }
      return false;
    };
    auto match_i = [&](const char* prefix, int& out) {
      size_t n = std::strlen(prefix);
      if (std::strncmp(a, prefix, n) == 0) { out = std::atoi(a + n); return true; }
      return false;
    };
    auto match_b = [&](const char* prefix, bool& out) {
      size_t n = std::strlen(prefix);
      if (std::strncmp(a, prefix, n) == 0) { out = (std::atoi(a + n) != 0); return true; }
      return false;
    };
    int   ti = 0; double td = 0; bool tb = false;
    if      (match_d("--pitch=", pitchHz))                      {}
    else if (match_i("--wpm=", wpm))                            {}
    else if (match_i("--lower=", ti))   progdefaults.CWlowerlimit = ti;
    else if (match_i("--upper=", ti))   progdefaults.CWupperlimit = ti;
    else if (match_i("--range=", ti))   progdefaults.CWrange      = ti;
    else if (match_d("--bw=", td))      progdefaults.CWbandwidth  = td;
    else if (match_b("--mfilt=", tb))   progdefaults.CWmfilt      = tb;
    else if (match_i("--attack=", ti))  progdefaults.cwrx_attack  = ti;
    else if (match_i("--decay=", ti))   progdefaults.cwrx_decay   = ti;
    else if (match_b("--lowercase=", tb)) progdefaults.rx_lowercase = tb;
    else if (match_d("--dashdot=", td)) progdefaults.CWdash2dot   = td;
    else if (match_b("--som=", tb))     progdefaults.CWuseSOMdecoding = tb;
  }
  if (pitchHz < 200.0)  pitchHz = 200.0;
  if (pitchHz > 2500.0) pitchHz = 2500.0;
  if (wpm < 5)  wpm = 5;
  if (wpm > 50) wpm = 50;
  progdefaults.CWsweetspot = int(pitchHz);
  progdefaults.CWspeed     = wpm;
  progdefaults.defCWspeed  = wpm;
  progdefaults.StartAtSweetSpot = true;

  cw* modem_cw = new cw();
  active_modem = modem_cw;
  modem_cw->init();
  modem_cw->rx_init();
  modem_cw->set_freq(pitchHz);

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
      std::fprintf(stderr, "[cw:gen] samples=%zu rate=%d ticks=%d\n",
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
    if (!out8k.empty()) modem_cw->rx_process(out8k.data(), int(out8k.size()));
  }
  return 0;
}
