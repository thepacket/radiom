// Stub: hardware FSK keyer (TX-only). RX-only build doesn't use it.
#pragma once
#include <string>
class FSK {
 public:
  FSK() {}
  ~FSK() {}
  void send(int) {}
  void start(int = 0, int = 0) {}
  void stop() {}
  bool active() const { return false; }
  // RTTY's resetFSK() touches these — RX-only build never reaches them.
  void fsk_shares_port(void*) {}
  bool open_port(const std::string&) { return false; }
  bool open_port(const char*) { return false; }
  void close_port() {}
  void shift_on_space(bool) {}
  void reverse(bool) {}
  void dtr(bool) {}
  void rts(bool) {}
};

struct rigio_stub { std::string device = ""; };
extern rigio_stub rigio;
