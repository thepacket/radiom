// Stub: fldigi's multi-channel PSK viewer dialog. We never display it; the
// REQ() macro routes to no-ops, but viewpsk.cxx still references these
// symbols and the NULLFREQ constant.
#pragma once

// NULLFREQ is defined inside fldigi's viewpsk.h; don't redefine here.
extern void viewaddchr(int ch, int freq, char c, int md);
extern void viewclearchannel(int ch);
