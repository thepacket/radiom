// Glue layer for the vendored fldigi PSK RX path.

#include <cstdio>
#include <cstdlib>
#include <cstdarg>
#include <string>

#include "configuration.h"
#include "status.h"
#include "fl_digi.h"
#include "globals.h"
#include "digiscope.h"
#include "waterfall.h"
#include "main.h"
#include "modem.h"
#include "morse.h"
#include "Viewer.h"

// ── globals fldigi expects ─────────────────────────────────────────────
progdefaults_t   progdefaults;
status_t         progStatus;
state_t          trx_state    = STATE_RX;
modem*           active_modem = nullptr;
Digiscope*       digiscope    = nullptr;
waterfall*       wf           = nullptr;
std::string      scDevice[2];
bool             mailserver   = false;
bool             mailclient   = false;
int              IMAGE_WIDTH  = 3000;

// Test-signal dialog stubs (TX-only, never instantiated for real).
#include "test_signal.h"
TestSignalWindowStub _test_signal_window;
TestSignalWindowStub* test_signal_window = &_test_signal_window;
ImdBtnStub  _btn_imd_on;
XmtImdStub  _xmtimd;
ImdBtnStub*  btn_imd_on = &_btn_imd_on;
XmtImdStub*  xmtimd     = &_xmtimd;
void set_phase(double, double, bool) {}


// ── TX-gen hooks (--gen flag in main.cpp) ──────────────────────────────
// When g_tx_gen_active is true, ModulateXmtr forwards modem PCM to stdout
// as int16 LE and get_tx_char streams from g_tx_gen_text. RX builds leave
// the flag false and both behave as no-ops / NODATA.
bool        g_tx_gen_active        = false;
size_t      g_tx_gen_samples_written = 0;
std::string g_tx_gen_text;
size_t      g_tx_gen_text_pos      = 0;

// modem static fields.
double         modem::frequency        = 1000.0;
double         modem::tx_frequency     = 1000.0;
bool           modem::freqlock         = false;
unsigned long  modem::tx_sample_count  = 0;
unsigned int   modem::tx_sample_rate   = 8000;
bool           modem::XMLRPC_CPS_TEST  = false;

// Minimal modem method bodies — only what psk.cxx ends up calling.
modem::modem() :
  morse(new cMorse), mode(0), scard(nullptr),
  stopflag(false), fragmentsize(512), samplerate(8000),
  reverse(false), sigsearch(0), sig_start(false), sig_stop(false),
  bandwidth(31.25), freqerr(0.0), rx_corr(0.0), tx_corr(0.0),
  PTTphaseacc(0.0),
  cwTrack(true), cwLock(false), cwRcvWPM(18.0), cwXmtWPM(18.0),
  squelch(0.0), metric(0.0), syncpos(0.0),
  backspaces(0), txstr(nullptr), txptr(nullptr),
  historyON(false),
  scopemode(Digiscope::PHASE),
  scptr(0),
  s2n_ncount(0), s2n_sum(0), s2n_sum2(0), s2n_metric(0), s2n_valid(false),
  cap(0), play_audio(false), CW_EOT(false)
{}
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
void modem::videoText()                {}

// fldigi GUI updaters psk.cxx pokes — no-ops here.
void put_cwRcvWPM(double)                  {}
void set_scope_mode(Digiscope::scope_mode) {}
void set_scope(double*, int, bool)         {}
void set_scope_xaxis_1(double)             {}
void put_MODEstatus(const char*, ...)      {}
void put_MODEstatus(trx_mode)              {}
void put_status(const char*, double, status_timeout)  {}
void put_Status1(const char*, double, status_timeout) {}
void put_Status2(const char*, double, status_timeout) {}
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

// PSK viewer dialog hooks — never called via REQ no-op, but linker needs them.
void viewaddchr(int, int, char, int) {}
void viewclearchannel(int) {}

// Optional waterfall viewer dialog and ancillary flags.
DlgViewerStub  _dlgViewerInstance;
DlgViewerStub* dlgViewer  = &_dlgViewerInstance;
bool           bHighSpeed = false;
bool           bHistory   = false;

// ── put_rx_char → stdout ───────────────────────────────────────────────
void put_rx_char(unsigned int c, int /*style*/) {
  unsigned char ch = static_cast<unsigned char>(c & 0xff);
  fputc(ch, stdout);
  fflush(stdout);
}
void put_echo_char(unsigned int /*c*/, int /*style*/) {}

// ── mode_info table ────────────────────────────────────────────────────
// olivia.cxx reads mode_info[mode].sname for status text. Empty-string
// entries are safe (std::string += never sees nullptr).
mode_info_t mode_info[NUM_MODES] = {};

namespace {
struct ModeInfoBootstrap {
  ModeInfoBootstrap() {
    for (int i = 0; i < NUM_MODES; ++i) {
      mode_info[i].mode           = i;
      mode_info[i].modem          = nullptr;
      mode_info[i].sname          = "";
      mode_info[i].name           = "";
      mode_info[i].pskmail_name   = "";
      mode_info[i].adif_name      = "";
      mode_info[i].export_mode    = "";
      mode_info[i].export_submode = "";
      mode_info[i].vid_name       = "";
    }
  }
} _mode_info_bootstrap;

struct Bootstrap {
  Bootstrap() {
    digiscope = new Digiscope();
    wf        = new waterfall();
  }
} _bootstrap;
}  // namespace
