#pragma once
// fldigi's misc/macros.h defines CLAMP. Minimal version below.
#ifndef CLAMP
#define CLAMP(x, lo, hi) ((x) < (lo) ? (lo) : (x) > (hi) ? (hi) : (x))
#endif
