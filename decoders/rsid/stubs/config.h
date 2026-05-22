// Minimal stub for fldigi's autoconf-generated config.h.
#pragma once
#define VERSION "fldigi-rsid-vendored"
#define PACKAGE "fldigi-rsid"

// fldigi's branch-prediction hints (normally from compiler.h, which we
// don't vendor). rsid.cxx uses these on the FFT hot path.
#ifndef likely
#define likely(x)   (x)
#endif
#ifndef unlikely
#define unlikely(x) (x)
#endif
