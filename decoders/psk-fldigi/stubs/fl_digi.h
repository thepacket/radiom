// Stub for fldigi's main UI header, extended for PSK status sinks.
#pragma once
#include <string>
#include "globals.h"
#include "digiscope.h"

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

struct Fl { static void awake() {} };

struct DlgViewerStub { bool visible() const { return false; } };
extern DlgViewerStub* dlgViewer;
extern bool bHighSpeed;
extern bool bHistory;
extern bool mailserver;
extern bool mailclient;
