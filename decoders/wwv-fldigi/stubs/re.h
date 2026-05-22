// Stub: fldigi POSIX-regex wrapper used by fsq.cxx for protocol parsing.
// We provide a no-op type that always reports "no match", so all the
// directed-message detection logic short-circuits.
#pragma once
#include <string>

#define REG_EXTENDED 0
#define REG_ICASE    0
#define REG_NOSUB    0

class fre_t {
public:
  fre_t(const char* = "", int = 0) {}
  bool match(const char*)         { return false; }
  bool match(const std::string&)  { return false; }
  std::string suffix() const      { return ""; }
  std::string submatch(int) const { return ""; }
  operator bool() const           { return false; }
};
