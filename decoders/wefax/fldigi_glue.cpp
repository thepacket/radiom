// Glue layer: globals, modem method bodies, and the wefax_pic NDJSON
// pixel sink. Hooked into fldigi's wefax.cxx via the qrunner.h direct-
// invoke macro and the wefax-pic.h stub class.

#include <algorithm>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "configuration.h"
#include "status.h"
#include "fl_digi.h"
#include "globals.h"
#include "digiscope.h"
#include "waterfall.h"
#include "main.h"
#include "modem.h"
#include "morse.h"
#include "wefax.h"
#include "wefax-pic.h"

// ── globals fldigi expects ─────────────────────────────────────────────
progdefaults_t   progdefaults;
status_t         progStatus;
state_t          trx_state    = STATE_RX;
modem*           active_modem = nullptr;
Digiscope*       digiscope    = nullptr;
waterfall*       wf           = nullptr;
std::string      scDevice[2];

// modem static fields.
double         modem::frequency        = 800.0;
double         modem::tx_frequency     = 800.0;
bool           modem::freqlock         = false;
unsigned long  modem::tx_sample_count  = 0;
unsigned int   modem::tx_sample_rate   = 11025;
bool           modem::XMLRPC_CPS_TEST  = false;

modem::modem() :
  morse(new cMorse), mode(0), scard(nullptr),
  stopflag(false), fragmentsize(512), samplerate(11025),
  reverse(false), sigsearch(0), sig_start(false), sig_stop(false),
  bandwidth(800.0), freqerr(0.0), rx_corr(0.0), tx_corr(0.0),
  PTTphaseacc(0.0),
  cwTrack(true), cwLock(false), cwRcvWPM(18.0), cwXmtWPM(18.0),
  squelch(0.0), metric(0.0), syncpos(0.0),
  backspaces(0), txstr(nullptr), txptr(nullptr),
  historyON(false),
  scopemode(Digiscope::SCOPE),
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
void modem::ModulateXmtr(double*, int) {}
void modem::ModulateStereo(double*, double*, int, bool) {}
void modem::ModulateVideoStereo(double*, double*, int, bool) {}
double modem::get_txfreq() const       { return frequency; }
int  modem::tx_process()               { return -1; }
void modem::pretone()                  {}
void modem::videoText()                {}

void set_scope_mode(Digiscope::scope_mode) {}

// fldigi's printf-style helper (formats into std::string). We provide the
// minimum signature wefax.cxx uses.
#include <cstdarg>
std::string strformat(const char* fmt, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  int n = std::vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  return std::string(buf, n > 0 ? std::min<int>(n, sizeof(buf) - 1) : 0);
}

// ── put_rx_char (wefax never calls this — chars come via wefax_pic) ──
void put_rx_char(unsigned int /*c*/, int /*style*/) {}
void put_echo_char(unsigned int /*c*/, int /*style*/) {}

// ── waterfall + digiscope singletons ───────────────────────────────────
namespace {
struct Bootstrap {
  Bootstrap() {
    digiscope = new Digiscope();
    wf        = new waterfall();
  }
} _bootstrap;
}

// =====================================================================
// wefax_pic: NDJSON row sink.
// =====================================================================
namespace {
constexpr size_t MAX_WIDTH = 4096;

int                  g_width        = 1810;   // typical for IOC576 at 120 LPM
int                  g_currentRow   = 0;
int                  g_emittedRows  = 0;
bool                 g_imageStarted = false;
std::vector<uint8_t> g_row;

const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
std::string base64(const uint8_t* p, size_t n) {
  std::string out;
  out.reserve((n + 2) / 3 * 4);
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = uint32_t(p[i]) << 16
               | (i + 1 < n ? uint32_t(p[i + 1]) << 8 : 0)
               | (i + 2 < n ? uint32_t(p[i + 2])      : 0);
    out += B64[(v >> 18) & 63];
    out += B64[(v >> 12) & 63];
    out += i + 1 < n ? B64[(v >> 6) & 63] : '=';
    out += i + 2 < n ? B64[v        & 63] : '=';
  }
  return out;
}
void emit_line(const std::string& s) {
  std::fwrite(s.data(), 1, s.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}
void emit_image_start_if_needed() {
  if (g_imageStarted) return;
  g_imageStarted = true;
  g_currentRow   = 0;
  g_emittedRows  = 0;
  g_row.assign(g_width, 0);
  std::string s = "{\"t\":\"image-start\",\"width\":" + std::to_string(g_width)
                + ",\"lpm\":120,\"ioc\":576}";
  emit_line(s);
}
void emit_row_buf(int seq) {
  std::string s = "{\"t\":\"row\",\"seq\":" + std::to_string(seq)
                + ",\"data\":\"" + base64(g_row.data(), g_row.size()) + "\"}";
  emit_line(s);
}
}  // namespace

void wefax_pic::update_rx_pic_bw(unsigned char data, int pos) {
  emit_image_start_if_needed();
  if (g_width <= 0) g_width = 1810;
  if (g_row.size() != size_t(g_width)) g_row.assign(g_width, 0);
  // fldigi's `pos` is in *bytes* (its image buffer is RGB, 3 bytes per
  // pixel even in B&W mode where the three bytes are identical). Convert
  // to a pixel index before computing row/col.
  constexpr int FLDIGI_BPP = 3;
  const int pixel = pos / FLDIGI_BPP;
  const int row   = pixel / g_width;
  const int col   = pixel % g_width;
  if (row != g_currentRow) {
    emit_row_buf(g_emittedRows++);
    std::memset(g_row.data(), 0, g_row.size());
    g_currentRow = row;
  }
  if (col >= 0 && col < g_width) g_row[col] = data;
}

void wefax_pic::resize_rx_viewer(int width_img) {
  if (width_img <= 0 || width_img > int(MAX_WIDTH)) return;
  if (width_img == g_width) return;
  g_width = width_img;
  g_row.assign(g_width, 0);
  // Re-emit image-start so the client picks up the new width.
  std::string s = "{\"t\":\"image-start\",\"width\":" + std::to_string(g_width)
                + ",\"lpm\":120,\"ioc\":576}";
  emit_line(s);
  g_currentRow  = 0;
  g_emittedRows = 0;
}

void wefax_pic::skip_rx_apt(void) {
  emit_line("{\"t\":\"status\",\"msg\":\"entering phasing detection\"}");
}
void wefax_pic::skip_rx_phasing(bool /*auto_center*/) {
  emit_line("{\"t\":\"status\",\"msg\":\"phasing locked — image starting\"}");
  // Image-start follows automatically when the first pixel arrives.
}
void wefax_pic::update_rx_lpm(int lpm) {
  std::string s = "{\"t\":\"status\",\"msg\":\"LPM " + std::to_string(lpm) + "\"}";
  emit_line(s);
}
void wefax_pic::update_auto_center(bool /*on*/) {}
void wefax_pic::set_rx_label(const std::string& /*lbl*/) {}
void wefax_pic::abort_rx_viewer(void) {
  if (g_imageStarted) {
    std::string s = "{\"t\":\"image-end\",\"height\":" + std::to_string(g_emittedRows) + "}";
    emit_line(s);
  }
  g_imageStarted = false;
  g_currentRow   = 0;
  g_emittedRows  = 0;
  // fldigi has just reset to RXAPTSTART (via end_rx). Re-skip APT so the
  // phasing detector keeps running for the next chart — otherwise the
  // decoder would idle until an actual APT start tone arrives, which
  // most receivers miss when tuning in mid-broadcast.
  if (active_modem) {
    static_cast<wefax*>(active_modem)->skip_apt();
  }
  emit_line("{\"t\":\"status\",\"msg\":\"waiting for next chart's phasing\"}");
}
void wefax_pic::save_image(const std::string& /*name*/, const std::string& /*comments*/) {
  if (g_imageStarted) {
    std::string s = "{\"t\":\"image-end\",\"height\":" + std::to_string(g_emittedRows) + "}";
    emit_line(s);
  }
  g_imageStarted = false;
}
void wefax_pic::send_image(const std::string& /*name*/) {}

// ── status text targets (no-op) ──
void put_Status1(const char*) {}
void put_Status2(const char*) {}
void put_MODEstatus(const char*, ...) {}
void put_MODEstatus(long /*mode*/)    {}
void activate_wefax_image_item(bool)  {}
void put_status(const char*)          {}

// ── ADIF / QSO log stubs (wefax.cxx writes to these on chart save when
//    progdefaults.WEFAX_AdifLog is true; we keep AdifLog=false so these
//    calls are reachable but harmless). ──────────────────────────────
#include "logbook.h"
QsodbStub     qsodb;
AdifFileStub  adifFile;
std::string   logbook_filename;
void loadBrowser(bool) {}

// (ADIF field constants live in logbook.h.)

// fldigi's mode_info table — declared in globals.h and read all over the
// place. The first read is wefax::update_rx_label() which std::string-
// appends `mode_info[mode].name`. A null `name` would crash strlen.
//
// Order matters: the array must be defined before the Filler so the
// Filler ctor (which writes into it via const_cast) runs second.
// Defined as non-const (we relaxed the declaration in our globals.h) so
// the Filler can initialise it at startup. fldigi only ever reads from
// mode_info after static init.
mode_info_t mode_info[NUM_MODES] = {};
namespace {
struct ModeInfoFiller {
  ModeInfoFiller() {
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
      // iface_io is `const unsigned int` — left default-initialised.
    }
    mode_info[MODE_WEFAX_576].sname = "WEFAX-576";
    mode_info[MODE_WEFAX_576].name  = "WEFAX-576";
    mode_info[MODE_WEFAX_576].adif_name = "WEFAX";
    mode_info[MODE_WEFAX_288].sname = "WEFAX-288";
    mode_info[MODE_WEFAX_288].name  = "WEFAX-288";
    mode_info[MODE_WEFAX_288].adif_name = "WEFAX";
  }
};
ModeInfoFiller _modeInfoFiller;
}  // namespace

