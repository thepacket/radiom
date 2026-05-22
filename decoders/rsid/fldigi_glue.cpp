// Glue layer for the vendored fldigi RSID decoder.
// Provides:
//   - global symbols fldigi expects (progdefaults, active_modem, wf, …)
//   - a minimal modem subclass (samplerate fixed at 11025) that
//     active_modem points at, satisfying the pure-virtuals in modem.h
//   - REQ-routed callbacks (init_modem, notify_rsid, set_*_tab_widgets)
//     either emit NDJSON to stdout (init_modem → detection event) or
//     are no-ops (mode-tab GUI updaters, KISS broadcast).
//
// fldigi's TX path was stripped from rsid.cxx, so all TX-related globals
// here exist only to satisfy modem-base linkage.

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
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
#include "rsid.h"
#include "audio_alert.h"
#include "data_io.h"
#include "arq_io.h"

// ── globals fldigi expects ─────────────────────────────────────────────
progdefaults_t   progdefaults;
status_t         progStatus;
state_t          trx_state    = STATE_RX;
modem*           active_modem = nullptr;
Digiscope*       digiscope    = nullptr;
waterfall*       wf           = nullptr;
std::string      scDevice[2];

bool             mailclient   = false;
bool             mailserver   = false;
data_io_mode_t   data_io_enabled = ARQ_IO;
AudioAlertStub*  audio_alert  = nullptr;

// modem static fields.
double         modem::frequency        = 1500.0;
double         modem::tx_frequency     = 1500.0;
bool           modem::freqlock         = false;
unsigned long  modem::tx_sample_count  = 0;
unsigned int   modem::tx_sample_rate   = 11025;
bool           modem::XMLRPC_CPS_TEST  = false;

modem::modem() :
  morse(new cMorse), mode(0), scard(nullptr),
  stopflag(false), fragmentsize(512), samplerate(11025),
  reverse(false), sigsearch(0), sig_start(false), sig_stop(false),
  bandwidth(0.0), freqerr(0.0), rx_corr(0.0), tx_corr(0.0),
  PTTphaseacc(0.0),
  cwTrack(false), cwLock(false), cwRcvWPM(0.0), cwXmtWPM(0.0),
  squelch(0.0), metric(0.0), syncpos(0.0),
  backspaces(0), txstr(nullptr), txptr(nullptr),
  historyON(false),
  scopemode(Digiscope::SCOPE),
  scptr(0),
  s2n_ncount(0), s2n_sum(0), s2n_sum2(0), s2n_metric(0), s2n_valid(false),
  cap(0), play_audio(false), CW_EOT(false)
{}
void modem::init()                      {}
void modem::set_freq(double f)          { frequency = f; }
double modem::get_txfreq_woffset() const { return frequency; }
void modem::set_freqlock(bool on)       { freqlock = on; }
void modem::set_bandwidth(double bw)    { bandwidth = bw; }
void modem::set_reverse(bool on)        { reverse = on; }
void modem::set_metric(double m)        { metric  = m; }
void modem::display_metric(double m)    { metric  = m; }
bool modem::get_cwTrack()               { return cwTrack; }
void modem::set_cwTrack(bool b)         { cwTrack = b; }
bool modem::get_cwLock()                { return cwLock; }
void modem::set_cwLock(bool b)          { cwLock = b; }
double modem::get_cwRcvWPM()            { return cwRcvWPM; }
double modem::get_cwXmtWPM()            { return cwXmtWPM; }
void modem::set_cwXmtWPM(double w)      { cwXmtWPM = w; }
void modem::set_samplerate(int s)       { samplerate = s; }
double modem::PTTnco()                  { return 0.0; }
double modem::sigmaN(double)            { return 0.0; }
double modem::gauss(double)             { return 0.0; }
void modem::add_noise(double*, int)     {}
void modem::s2nreport()                 {}
int  modem::get_quality(int)            { return 0; }
int  modem::update_quality(int v, int)  { return v; }
void modem::ModulateXmtr(double*, int)  {}
void modem::ModulateStereo(double*, double*, int, bool) {}
void modem::ModulateVideoStereo(double*, double*, int, bool) {}
double modem::get_txfreq() const        { return frequency; }
int  modem::tx_process()                { return -1; }
void modem::pretone()                   {}
void modem::videoText()                 {}

void set_scope_mode(Digiscope::scope_mode) {}

// ── put_rx_char / put_echo_char (RSID never emits text) ────────────────
void put_rx_char(unsigned int /*c*/, int /*style*/) {}
void put_echo_char(unsigned int /*c*/, int /*style*/) {}

// ── status text targets (no-op) ──
void put_Status1(const char*) {}
void put_Status2(const char*) {}
void put_MODEstatus(const char*, ...) {}
void put_MODEstatus(long /*mode*/)    {}
void activate_wefax_image_item(bool)  {}
void put_status(const char*)          {}
void put_status(const char*, double)  {}

// ── waterfall + digiscope + audio_alert singletons ─────────────────────
namespace {
struct Bootstrap {
  Bootstrap() {
    digiscope   = new Digiscope();
    wf          = new waterfall();
    audio_alert = new AudioAlertStub();
  }
} _bootstrap;
}

// ── RSID-specific REQ-routed callbacks ────────────────────────────────
// REQ() in our qrunner.h direct-invokes; these fire on every detection.

namespace {
void emit_detect(int mode, double rsidfreq, const char* tag) {
  const char* name = (mode >= 0 && mode < NUM_MODES) ? mode_info[mode].sname : nullptr;
  if (!name || !*name) name = "?";
  std::fprintf(stdout,
               "{\"t\":\"%s\",\"mode\":\"%s\",\"id\":%d,\"freq\":%.1f}\n",
               tag, name, mode, rsidfreq);
  std::fflush(stdout);
}
}  // namespace

void init_modem(int mode, double freq)         { emit_detect(mode, freq, "detect"); }
void init_modem_squelch(int mode, double freq) { emit_detect(mode, freq, "detect"); }

void notify_rsid(int /*mode*/, double /*freq*/) {}
void notify_rsid_eot(int mode, double freq)     { emit_detect(mode, freq, "eot"); }
void note_qrg(bool, const char*, const char*, int /*mode*/, long long, double) {}
void pskmail_notify_rsid(int /*mode*/) {}
void toggleRSID() {}
void rsid_eot_squelch() {}
void bcast_rsid_kiss_frame(double, int, int, int, int) {}

// fldigi's modem-tab widget GUI updaters. rsid.cxx pokes these inside
// setup_mode() to push the chosen sub-mode into the tab UI; we have no
// UI, and the host process owns mode-switching, so they're all no-ops.
void set_rtty_tab_widgets()       {}
void set_olivia_tab_widgets()     {}
void set_contestia_tab_widgets()  {}
void set_dominoex_tab_widgets()   {}

// strformat — fldigi's printf-into-string helper. Not referenced by
// rsid.cxx today but keep the symbol available in case a downstream
// vendored translation unit references it.
std::string strformat(const char* fmt, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  std::vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  return std::string(buf);
}
