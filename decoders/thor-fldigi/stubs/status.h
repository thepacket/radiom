// Stub: fldigi's program-status struct, expanded for PSK fields.
#pragma once
#include <string>

struct status_t {
  int    sldrSquelchValue   = 0;
  bool   sqlonoff           = false;
  bool   show_channels      = false;
  bool   WK_online          = false;
  double carrier            = 0.0;
  bool   afconoff           = true;       // PSK AFC on by default
  bool   psk8DCDShortFlag   = false;
  double VIEWER_psksquelch  = -20.0;
  bool   fsq_rx_abort       = false;
};

extern status_t progStatus;
