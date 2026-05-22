// Stub: fldigi's timeops provides a few helpers. We implement just what's
// needed by cw.cxx (mclock for monotonic ms timestamps).
#pragma once
#include <chrono>
#include <ctime>
#include <sys/time.h>

inline unsigned long long zmsec() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}
inline double zsec() {
  using namespace std::chrono;
  return duration_cast<duration<double>>(steady_clock::now().time_since_epoch()).count();
}
