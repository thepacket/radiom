#pragma once
#include <string>

extern std::string scDevice[2];

// rsid.cxx fan-out targets routed through REQ() — we direct-invoke them.
extern void set_rtty_tab_widgets();
extern void set_olivia_tab_widgets();
extern void set_contestia_tab_widgets();
extern void set_dominoex_tab_widgets();
extern void init_modem(int mode, double freq);
extern void init_modem_squelch(int mode, double freq);
extern void toggleRSID();
extern void rsid_eot_squelch();
extern void note_qrg(bool, const char*, const char*, int mode, long long, double);
extern void pskmail_notify_rsid(int mode);
