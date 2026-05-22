// Stub for fldigi's main UI header. We expose only the symbols cw.cxx
// actually uses for receive-side decoding.
#pragma once
#include <cassert>
#include <cstdio>
#include <string>
#include "globals.h"
#include "waterfall.h"

// PUT_STATUS macro (fldigi puts status updates on the GUI status line).
// We swallow them — verbose status would otherwise pollute stdout.
// (PUT_STATUS is defined in wefax.cxx with a different signature, so we
// don't redefine it here — wefax.cxx's local macro wins.)
#define IMAGE_WIDTH (12000)        // wefax.cxx falls back to this when carrier is at the band edge
extern void put_Status1(const char*);
extern void put_Status2(const char*);

// Receive-character sink. fldigi pushes decoded characters into the GUI
// transcript here; our binary redirects to stdout via fldigi_glue.cpp.
extern void put_rx_char(unsigned int c, int style = 0);
extern void put_echo_char(unsigned int c, int style = 0);

// Active modem pointer — set by wrapper main().
class modem;
extern modem* active_modem;

// fldigi's transmit/receive state. We never transmit, but cw.cxx checks it.
extern state_t trx_state;

// fldigi GUI updaters cw.cxx pokes (typically via REQ()). We provide
// concrete no-op implementations in fldigi_glue.cpp.
#include "digiscope.h"
// fldigi's get_tx_char()/queue protocol — returns these sentinels when no
// printable character is queued. We never queue any.
#define GET_TX_CHAR_NODATA  (-1)
#define GET_TX_CHAR_ETX     (-2)

// fldigi's transmit-side WPM setter (TX-only; safe no-op).
extern void set_CWwpm();

// FLTK threading hook used by fldigi's TX path; no-op.
struct Fl { static void awake() {} };

extern void put_cwRcvWPM(double);
extern void set_scope_mode(Digiscope::scope_mode);
extern void set_scope(double*, int, bool);
extern void set_scope_xaxis_1(double);
extern void put_MODEstatus(const char* fmt, ...);
extern void put_MODEstatus(long mode);  // overload: wefax.cxx calls with trx_mode
extern void activate_wefax_image_item(bool on);
extern void put_status(const char*);
// rsid.cxx form: put_status(msg, timeout_seconds).
extern void put_status(const char*, double);
extern int  get_tx_char();
extern double get_txfreq_woffset();

// Optional waterfall "viewer" dialog. We never show it, but cw.cxx
// checks dlgViewer->visible(). Stub object exposes a visible() method.
struct DlgViewerStub { bool visible() const { return false; } };
extern DlgViewerStub* dlgViewer;
extern bool bHighSpeed;
extern bool bHistory;
