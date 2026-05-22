// Stub: fldigi's POSIX regex wrapper. navtex.cxx doesn't call it
// directly, but the vendored strutil.cxx pulls it in for its `split()`
// helper. A minimal class shape is enough — navtex never invokes split.
#pragma once
#include <regex.h>
#include <string>
#include <vector>

class re_t {
public:
  re_t(const char* = "", int = 0) {}
  re_t(const re_t&) {}
  re_t& operator=(const re_t&) { return *this; }
  bool match(const char*, int = 0) { return false; }
  bool error() const { return false; }
};

class fre_t : public re_t {
public:
  fre_t(const char* p = "", int f = 0) : re_t(p, f) {}
  bool match(const char*, int = 0) { return false; }
  size_t suboff(size_t, size_t* a, size_t* b) const { *a = 0; *b = 0; return 0; }
  size_t nsub() const { return 0; }
};
