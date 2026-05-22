#pragma once
// fldigi's KISS framing path. rsid.cxx wraps the broadcast in a
// `if (data_io_enabled == KISS_IO)` guard; we leave KISS disabled.
enum data_io_mode_t { ARQ_IO = 0, KISS_IO };
// fldigi globals.cxx uses these in the mode_info table iface_io column.
enum { DISABLED_IO = 0, ENABLED_IO = 1, ARQ_KISS_IO = 2 };
extern data_io_mode_t data_io_enabled;

#define RSID_KISS_NOTIFY 0

extern void bcast_rsid_kiss_frame(double rsidfreq, int mbin, int txfreq,
                                  int mode, int kind);
