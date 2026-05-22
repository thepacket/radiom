// Stub: FLTK alert dialog. navtex.cxx pops up confirmation dialogs in
// some TX paths. RX-only build → never invoked.
#pragma once
inline int fl_ask(const char*, ...) { return 0; }
inline int fl_alert(const char*, ...) { return 0; }
inline int fl_choice(const char*, const char*, const char*, const char*, ...) { return 0; }
