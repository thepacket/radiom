// Driver: reads 12 kHz int16 PCM from stdin, resamples to 8 kHz (PSK31's
// internal rate), feeds the vendored fldigi psk modem, and lets
// put_rx_char() flush characters to stdout.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "modem.h"
#include "psk.h"
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
    const double step = double(IN_RATE) / double(OUT_RATE);  // 12000/8000 = 1.5
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
}  // namespace

// Defined in fldigi_glue.cpp — when --gen is passed we flip these and the
// modem's TX path runs through put_tx_char + ModulateXmtr-to-stdout instead
// of the usual RX-from-stdin loop.
extern bool        g_tx_gen_active;
extern std::string g_tx_gen_text;
extern size_t      g_tx_gen_text_pos;
extern size_t      g_tx_gen_samples_written;

int main(int argc, char** argv) {
  double      pitchHz = 1000.0;
  trx_mode    mode    = MODE_PSK31;
  bool        gen     = false;
  std::string genText;
  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
    if      (std::strcmp(a, "--gen") == 0)       gen = true;
    else if (std::strncmp(a, "--text=", 7) == 0) genText = a + 7;
    else if (std::strncmp(a, "--pitch=", 8) == 0) pitchHz = std::strtod(a + 8, nullptr);
    else if (std::strncmp(a, "--mode=", 7) == 0) {
      const char* m = a + 7;
      if      (!std::strcmp(m, "bpsk31"))    mode = MODE_PSK31;
      else if (!std::strcmp(m, "bpsk63"))    mode = MODE_PSK63;
      else if (!std::strcmp(m, "bpsk63f"))   mode = MODE_PSK63F;
      else if (!std::strcmp(m, "bpsk125"))   mode = MODE_PSK125;
      else if (!std::strcmp(m, "bpsk250"))   mode = MODE_PSK250;
      else if (!std::strcmp(m, "bpsk500"))   mode = MODE_PSK500;
      else if (!std::strcmp(m, "bpsk1000"))  mode = MODE_PSK1000;
      else if (!std::strcmp(m, "qpsk31"))    mode = MODE_QPSK31;
      else if (!std::strcmp(m, "qpsk63"))    mode = MODE_QPSK63;
      else if (!std::strcmp(m, "qpsk125"))   mode = MODE_QPSK125;
      else if (!std::strcmp(m, "qpsk250"))   mode = MODE_QPSK250;
      else if (!std::strcmp(m, "qpsk500"))   mode = MODE_QPSK500;
      // 8PSK
      else if (!std::strcmp(m, "8psk125"))   mode = MODE_8PSK125;
      else if (!std::strcmp(m, "8psk125fl")) mode = MODE_8PSK125FL;
      else if (!std::strcmp(m, "8psk125f"))  mode = MODE_8PSK125F;
      else if (!std::strcmp(m, "8psk250"))   mode = MODE_8PSK250;
      else if (!std::strcmp(m, "8psk250fl")) mode = MODE_8PSK250FL;
      else if (!std::strcmp(m, "8psk250f"))  mode = MODE_8PSK250F;
      else if (!std::strcmp(m, "8psk500"))   mode = MODE_8PSK500;
      else if (!std::strcmp(m, "8psk500f"))  mode = MODE_8PSK500F;
      else if (!std::strcmp(m, "8psk1000"))  mode = MODE_8PSK1000;
      else if (!std::strcmp(m, "8psk1000f")) mode = MODE_8PSK1000F;
      else if (!std::strcmp(m, "8psk1200f")) mode = MODE_8PSK1200F;
      // PSK-R (FEC + interleaver)
      else if (!std::strcmp(m, "psk125r"))   mode = MODE_PSK125R;
      else if (!std::strcmp(m, "psk250r"))   mode = MODE_PSK250R;
      else if (!std::strcmp(m, "psk500r"))   mode = MODE_PSK500R;
      else if (!std::strcmp(m, "psk1000r"))  mode = MODE_PSK1000R;
    }
    else if (std::strncmp(a, "--acqsn=",  8) == 0) progdefaults.ACQsn       = std::strtod(a + 8,  nullptr);
    else if (std::strncmp(a, "--search=", 9) == 0) progdefaults.SearchRange = std::atoi(a + 9);
  }
  if (pitchHz < 200.0)  pitchHz = 200.0;
  if (pitchHz > 3000.0) pitchHz = 3000.0;
  progdefaults.PSKsweetspot   = int(pitchHz);
  progdefaults.StartAtSweetSpot = true;
  progStatus.afconoff         = true;

  psk* modem_psk = new psk(mode);
  active_modem = modem_psk;
  modem_psk->init();

  if (gen) {
    // ── TX-generate mode: drive the modem's transmit path until the seeded
    // text buffer is consumed and tx_process() returns -1 (postamble done).
    // Output: raw int16 LE PCM at the modem's samplerate (typically 8 kHz).
    g_tx_gen_active   = true;
    g_tx_gen_text     = genText.empty() ? "VVV CQ CQ DE RADIOM TEST TEST TEST K" : genText;
    g_tx_gen_text_pos = 0;
    modem_psk->set_freq(pitchHz);
    modem_psk->tx_init();
    int rc = 0;
    int safetyTicks = 0;
    while (rc == 0 && safetyTicks++ < 200000) {
      rc = modem_psk->tx_process();
    }
    // Pad trailing silence so the RX-side decoder can flush PSKR FEC.
    {
      const int sr = modem_psk->get_samplerate();
      const int padSamples = sr * 15;
      int16_t z = 0;
      for (int i = 0; i < padSamples; i++) std::fwrite(&z, 2, 1, stdout);
    }
    std::fflush(stdout);
    std::fprintf(stderr, "[psk-fldigi:gen] mode=%s samples=%zu rate=%d ticks=%d\n",
                 argv[2] ? argv[2] : "?", g_tx_gen_samples_written,
                 modem_psk->get_samplerate(), safetyTicks);
    return 0;
  }

  modem_psk->rx_init();
  modem_psk->set_freq(pitchHz);

  static int16_t       inBuf[1024];
  std::vector<double>  in12k;  in12k.reserve(1024);
  std::vector<double>  out8k;  out8k.reserve(1024);
  LinearResampler      rs;

  for (;;) {
    size_t n = fread(inBuf, sizeof(int16_t), sizeof(inBuf) / sizeof(int16_t), stdin);
    if (n == 0) {
      if (feof(stdin)) break;
      continue;
    }
    in12k.resize(n);
    for (size_t i = 0; i < n; i++) in12k[i] = double(inBuf[i]) / 32768.0;
    rs.process<12000, 8000>(in12k.data(), n, out8k);
    // psk's rx_process uses sliding filters — no fixed chunk-size cap, but
    // feed in modest-sized blocks anyway.
    const size_t MAX = 512;
    for (size_t off = 0; off < out8k.size(); off += MAX) {
      size_t take = std::min(MAX, out8k.size() - off);
      modem_psk->rx_process(out8k.data() + off, int(take));
    }
  }
  return 0;
}
