// Stub: fldigi's multi-channel RTTY viewer. RX-only build doesn't display
// it — rtty.h declares a `view_rtty *` member; the type just needs to exist.
#pragma once
class view_rtty {
 public:
  view_rtty(int = 0) {}
  ~view_rtty() {}
  void restart(int = 0) {}
  void rx_process(const double*, int) {}
  void clearch(int) {}
  void clear() {}
  int  get_freq(int = 0) const { return 0; }
};

struct SynopDB {
  static void usage() {}
  struct Init { Init() {} };
};
