// Stub: fldigi's picture widget (FLTK-based RX/TX image rendering). RX-only
// build never instantiates one; mfsk.h declares two `picture *` extern
// pointers, so the type just needs to exist.
#pragma once
#include <string>
class picture {
 public:
  picture(int, int, int, int, int = 0) {}
  ~picture() {}
  bool save_png(const char*) const { return false; }
};
