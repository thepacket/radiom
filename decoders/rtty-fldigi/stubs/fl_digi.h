// Stub for fldigi's main UI header, extended for PSK status sinks.
#pragma once
#include <string>
#include "globals.h"
#include "digiscope.h"
#include "waterfall.h"
#include "configuration.h"
#include "qrunner.h"

extern void put_rx_char(unsigned int c, int style = 0);
extern void put_echo_char(unsigned int c, int style = 0);

class modem;
extern modem* active_modem;
extern state_t trx_state;

#define GET_TX_CHAR_NODATA  (-1)
#define GET_TX_CHAR_ETX     (-2)

enum status_timeout { STATUS_CLEAR, STATUS_DIM, STATUS_RESTORE };

extern void put_status(const char *msg, double timeout = 0.0, status_timeout action = STATUS_CLEAR);
extern void put_Status1(const char *msg, double timeout = 0.0, status_timeout action = STATUS_CLEAR);
extern void put_Status2(const char *msg, double timeout = 0.0, status_timeout action = STATUS_CLEAR);

extern void set_CWwpm();
extern void put_cwRcvWPM(double);
extern void set_scope_mode(Digiscope::scope_mode);
extern void set_scope(double*, int, bool);
extern void set_scope_xaxis_1(double);
extern void put_MODEstatus(const char* fmt, ...);
extern void put_MODEstatus(trx_mode mode);
extern int  get_tx_char();
extern double get_txfreq_woffset();
extern void videoText();
extern void set_phase(double phase, double quality, bool highlight);
extern void activate_mfsk_image_item(bool);
extern void start_deadman();
extern void stop_deadman();
extern int  load_image(const char*);

// MFSK uses set_scope() with two signatures (two- and three-arg). The
// other decoders only need one.
extern void set_scope(double* data, int len);

#define GET_THREAD_ID() 0
#define REQ_FLUSH(...)  ((void)0)

struct Fl { static void awake() {} };

struct DlgViewerStub { bool visible() const { return false; } };
extern DlgViewerStub* dlgViewer;
extern bool bHighSpeed;
extern bool bHistory;
extern bool mailserver;
extern bool mailclient;

// FSQ ─────────────────────────────────────────────────────────────
#include "FTextBase.h"
#include "notify_dialog.h"
extern void display_fsq_rx_text(const std::string& s, int style = 0);
extern void display_fsq_mon_text(const std::string& s, int style = 0);
extern void show_notifier(notify_dialog*);
extern void close_fsqMonitor();
extern void enableSELCAL();
extern void add_to_heard_list(const std::string&, const std::string&);
extern void post_alert(std::string s1, double timeout, std::string s2);
extern void fsq_showRxViewer(int, int, const std::string&);
extern void fsq_updateRxPic(unsigned char, int);
extern void fsq_updateTxPic(unsigned char, int);
extern void fsq_clear_rximage();
extern void fsq_clear_tximage();
extern void fsq_enableshift();

// Misc helpers
inline int fl_utf8froma(char* dst, int dstsz, const char* src, int srcsz) {
  int n = (srcsz < dstsz - 1) ? srcsz : dstsz - 1;
  for (int i = 0; i < n; i++) dst[i] = src[i];
  dst[n] = 0;
  return n;
}
extern std::string TempDir;
extern std::string zdate();
extern std::string ztime();
extern std::string zshowtime();

// THOR ─────────────────────────────────────────────────────────────
extern void put_sec_char(int);
extern void activate_thor_image_item(bool);
extern void thor_clear_avatar();
extern void thor_showRxViewer(const char*);
extern void thor_update_avatar(unsigned char, int);
extern void thor_updateRxPic(unsigned char, int);
extern void thor_clear_tximage();
extern void thor_enableshift();
extern void set_video(double*, int, bool);

// RTTY scope helper. `cmplx` is a typedef of std::complex<double> defined in
// complex.h; we use void* here to avoid include-order coupling.
extern void set_zdata(void*, int);

// FSQ TX-side bits we never use but fsq.cxx references unconditionally.
struct FsqStubBtn { int  value() { return 0; } void value(int) {} };
struct FsqStubVal { double value() { return 0.0; } void value(double) {} };
extern FsqStubBtn* btn_SELCAL;
extern FsqStubBtn* btnOffsetOn;
extern FsqStubVal* ctrl_freq_offset;

// fsq.cxx calls heard_list() to format the seen-stations list as text.
inline std::string heard_list() { return ""; }

inline const char* fl_filename_name(const char* p) {
  if (!p) return "";
  const char* s = p;
  for (const char* c = p; *c; ++c) if (*c == '/' || *c == '\\') s = c + 1;
  return s;
}

#ifndef PACKAGE_VERSION
#define PACKAGE_VERSION "radiom"
#endif

// FSQ image-TX globals (gutted in our RX-only build).
struct FsqPicWin {
  bool visible() const { return false; }
  void show() {}
  void hide() {}
};
extern FsqPicWin* fsqpicTxWin;
struct FsqSelStub { int value() { return 0; } };
extern FsqSelStub* selfsqpicSize;
inline int fsqpic_TxGetPixel(int, int = 0) { return 0; }

// FSQ TX-side helpers we never invoke but fsq.cxx references.
extern void write_fsq_que(const char*);
extern void fsq_xmt(const char*);

struct FsqTxText {
  void clear() {}
  void addstr(const char*) {}
  void replace(int, int, const char*) {}
  int  buffer_length() const { return 0; }
  std::string text() const { return ""; }
};
extern FsqTxText* fsq_tx_text;
