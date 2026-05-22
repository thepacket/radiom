// Stub: fldigi's oscilloscope widget. Provides the enum type used as a
// member of `modem`, plus enough no-op interface for cw.cxx.
#pragma once

class Digiscope {
public:
  enum scope_mode {
    XHAIRS, RTTY, PHASE, SCOPE, WWV, DOMWF, DOMDATA, BLANK, FREQ,
    NUM_MODES
  };
  void mode(scope_mode) {}
  void data(double*, int, bool = false) {}
  void clear() {}
};

extern Digiscope* digiscope;
