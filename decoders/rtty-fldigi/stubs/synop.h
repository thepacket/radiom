// Stub: SYNOP weather-telegram decoder. Disabled in our RX-only build —
// the RTTY decoder still streams chars through put_rx_char, but Synop's
// regex/parser path is gutted to avoid pulling in its data files.
#pragma once
#include <string>

class synop_callback {
 public:
  virtual ~synop_callback() {}
  virtual bool interleaved(void) const { return true; }
  virtual void print(const char*, size_t, bool) const = 0;
  virtual bool log_adif(void) const = 0;
  virtual bool log_kml(void) const = 0;
};

class synop {
 public:
  static const synop_callback* ptr_callback;
  template<class Callback>
  static void setup() {
    static const Callback cstCall = Callback();
    ptr_callback = &cstCall;
  }
  static synop* instance();
  void init() {}
  void cleanup() {}
  void add(char) {}
  void flush(bool) {}
  bool enabled(void) const { return false; }
  static bool GetTestMode(void) { return false; }
  static void SetTestMode(bool) {}
};
