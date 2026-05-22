// Stub: hardware keyer over USB. RX-only build. fldigi treats these as
// global mutable state, so we expose them as variables (not functions).
#pragma once
extern bool use_nanoIO;
inline void nano_send_char(int)       {}
inline void set_nanoCW()              {}
inline void set_nanoWPM(int)          {}
inline void set_nano_dash2dot(double) {}
