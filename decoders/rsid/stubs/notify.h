#pragma once
// fldigi GUI notifications. rsid.cxx routes detection events through
// REQ(notify_rsid, mode, freq) and REQ(notify_rsid_eot, ...). Our REQ
// macro direct-invokes; we resolve these into stdout NDJSON in the glue.
extern void notify_rsid(int mode, double freq);
extern void notify_rsid_eot(int mode, double freq);
