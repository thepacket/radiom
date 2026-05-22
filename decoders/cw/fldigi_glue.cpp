// Glue layer: provides the global symbols, sinks, and minimal modem
// implementation that the vendored fldigi cw.cxx + morse.cxx + filters
// expect to find at link time.

#include <cstdio>
#include <cstdlib>
#include <string>

// ── TX-gen hooks (--gen flag in main.cpp) ──────────────────────────────
// When g_tx_gen_active is true, ModulateXmtr forwards modem PCM to stdout
// as int16 LE and get_tx_char streams from g_tx_gen_text. RX builds leave
// the flag false and both behave as no-ops / NODATA.
bool        g_tx_gen_active        = false;
size_t      g_tx_gen_samples_written = 0;
std::string g_tx_gen_text;
size_t      g_tx_gen_text_pos      = 0;


#include "configuration.h"
#include "status.h"
#include "fl_digi.h"
#include "globals.h"
#include "digiscope.h"
#include "waterfall.h"
#include "main.h"
#include "modem.h"
#include "morse.h"

// ── globals fldigi expects ─────────────────────────────────────────────
progdefaults_t   progdefaults;
status_t         progStatus;
state_t          trx_state    = STATE_RX;
modem*           active_modem = nullptr;
Digiscope*       digiscope    = nullptr;
waterfall*       wf           = nullptr;
std::string      scDevice[2];

// modem static fields (we don't ship the full fldigi modem.cxx).
double         modem::frequency        = 800.0;
double         modem::tx_frequency     = 800.0;
bool           modem::freqlock         = false;
unsigned long  modem::tx_sample_count  = 0;
unsigned int   modem::tx_sample_rate   = 12000;
bool           modem::XMLRPC_CPS_TEST  = false;

// Minimal modem method bodies — only what cw.cxx ends up calling.
modem::modem() :
  morse(new cMorse), mode(0), scard(nullptr),
  stopflag(false), fragmentsize(512), samplerate(12000),
  reverse(false), sigsearch(0), sig_start(false), sig_stop(false),
  bandwidth(150.0), freqerr(0.0), rx_corr(0.0), tx_corr(0.0),
  PTTphaseacc(0.0),
  cwTrack(true), cwLock(false), cwRcvWPM(18.0), cwXmtWPM(18.0),
  squelch(0.0), metric(0.0), syncpos(0.0),
  backspaces(0), txstr(nullptr), txptr(nullptr),
  historyON(false),
  scopemode(Digiscope::SCOPE),
  scptr(0),
  s2n_ncount(0), s2n_sum(0), s2n_sum2(0), s2n_metric(0), s2n_valid(false),
  cap(0), play_audio(false), CW_EOT(false)
{
  // PTTchannel and outbuf remain default-uninitialised; only used during TX.
}
void modem::init()                     {}
void modem::set_freq(double f)         { frequency = f; }
double modem::get_txfreq_woffset() const { return frequency; }
void modem::set_freqlock(bool on)      { freqlock = on; }
void modem::set_bandwidth(double bw)   { bandwidth = bw; }
void modem::set_reverse(bool on)       { reverse = on; }
void modem::set_metric(double m)       { metric  = m; }
void modem::display_metric(double m)   { metric  = m; }
bool modem::get_cwTrack()              { return cwTrack; }
void modem::set_cwTrack(bool b)        { cwTrack = b; }
bool modem::get_cwLock()               { return cwLock; }
void modem::set_cwLock(bool b)         { cwLock = b; }
double modem::get_cwRcvWPM()           { return cwRcvWPM; }
double modem::get_cwXmtWPM()           { return cwXmtWPM; }
void modem::set_cwXmtWPM(double w)     { cwXmtWPM = w; }
void modem::set_samplerate(int s)      { samplerate = s; }
double modem::PTTnco()                 { return 0.0; }
double modem::sigmaN(double)           { return 0.0; }
double modem::gauss(double)            { return 0.0; }
void modem::add_noise(double*, int)    {}
void modem::s2nreport()                {}
int  modem::get_quality(int)           { return 0; }
int  modem::update_quality(int v, int) { return v; }
void modem::ModulateXmtr(double* p, int n) {
  if (!g_tx_gen_active) return;
  for (int i = 0; i < n; i++) {
    double v = p[i];
    if (v < -1.0) v = -1.0; else if (v > 1.0) v = 1.0;
    int16_t s = (int16_t)(v * 32767.0);
    std::fwrite(&s, 2, 1, stdout);
    g_tx_gen_samples_written++;
  }
}
void modem::ModulateStereo(double*, double*, int, bool) {}
void modem::ModulateVideoStereo(double*, double*, int, bool) {}
double modem::get_txfreq() const       { return frequency; }
int  modem::tx_process()               { return -1; }
void modem::pretone()                  {}

// Multi-channel CW viewer — header is included by cw.h, but we never use
// the side panel. Stub the constructor/destructor and the two methods
// cw.cxx calls so the linker is satisfied.
#include "view_cw.h"
cMorse* CW_CHANNEL::morse = nullptr;
CW_CHANNEL::CW_CHANNEL()  {}
CW_CHANNEL::~CW_CHANNEL() {}
view_cw::view_cw()  {}
view_cw::~view_cw() {}
void view_cw::restart() {}
int  view_cw::rx_process(const double*, int) { return 0; }

// Hardware-keyer thread hooks (TX-side); RX build never starts them, but
// the cw constructor/destructor reference them.
void start_cwio_thread() {}
void stop_cwio_thread()  {}
// Hardware-keyer flags fldigi treats as global mutable state.
bool use_nanoIO    = false;
bool use_KYkeyer   = false;
bool use_ICOMkeyer = false;
bool use_YAESUkeyer= false;
bool use_WK_keyer  = false;

// fldigi GUI updaters cw.cxx pokes via REQ() — no-ops here.
void put_cwRcvWPM(double)                  {}
void set_scope_mode(Digiscope::scope_mode) {}
void set_scope(double*, int, bool)         {}
void set_scope_xaxis_1(double)             {}
void put_MODEstatus(const char*, ...)      {}
int  g_tx_gen_grace = 0;
int  get_tx_char() {
  if (!g_tx_gen_active) return GET_TX_CHAR_NODATA;
  if (g_tx_gen_text_pos >= g_tx_gen_text.size()) {
    // Return NODATA once so navtex/process_tx exits its drain loop cleanly,
    // then ETX so PSK/Olivia/MFSK/THOR see the end-of-message and trigger
    // the postamble + stopflag path.
    return (g_tx_gen_grace++ < 1) ? GET_TX_CHAR_NODATA : GET_TX_CHAR_ETX;
  }
  return (unsigned char)g_tx_gen_text[g_tx_gen_text_pos++];
}
void set_CWwpm()                            {}
double get_txfreq_woffset() {
  return active_modem ? active_modem->get_txfreq_woffset() : 0.0;
}

// Optional waterfall viewer dialog and ancillary flags.
DlgViewerStub  _dlgViewerInstance;
DlgViewerStub* dlgViewer  = &_dlgViewerInstance;
bool           bHighSpeed = false;
bool           bHistory   = false;

// ── put_rx_char → stdout ───────────────────────────────────────────────
// fldigi pushes every decoded character through this function. We
// redirect to stdout so the parent Node process picks it up via the
// child's pipe.
void put_rx_char(unsigned int c, int /*style*/) {
  unsigned char ch = static_cast<unsigned char>(c & 0xff);
  fputc(ch, stdout);
  fflush(stdout);
}
void put_echo_char(unsigned int /*c*/, int /*style*/) {
  // No-op: fldigi calls this for transmit-side echo, which we never use.
}

// ── waterfall + digiscope singletons ───────────────────────────────────
// Defined here so cw.cxx can dereference `wf` and `digiscope` without
// crashing. No GUI-side processing happens.
namespace {
struct Bootstrap {
  Bootstrap() {
    digiscope = new Digiscope();
    wf        = new waterfall();
  }
} _bootstrap;
}
