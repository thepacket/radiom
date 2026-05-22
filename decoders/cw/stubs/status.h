// Stub: fldigi's program-status struct. cw.cxx reads a handful of fields
// during demod; we provide them with safe defaults.
#pragma once
#include <string>

struct status_t {
  int    sldrSquelchValue = 0;
  bool   sqlonoff         = false;
  bool   show_channels    = false;
  bool   WK_online        = false;
  double carrier          = 0.0;
};

extern status_t progStatus;
