// Stub: fldigi's test-signal generator dialog. RX-only build never opens it.
#pragma once

struct TestSignalWindowStub {
  bool visible() { return false; }
};
extern TestSignalWindowStub* test_signal_window;

struct ImdBtnStub  { int    value() { return 0; } };
struct XmtImdStub  { double value() { return -30.0; } };

extern ImdBtnStub*  btn_imd_on;
extern XmtImdStub*  xmtimd;
