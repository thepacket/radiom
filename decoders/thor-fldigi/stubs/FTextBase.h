// Stub: fldigi FTextBase scrolling-text widget. RX-only build doesn't
// render. We only need the style enum so fsq.cxx compiles.
#pragma once
struct FTextBase {
  enum {
    RECV, XMIT, CTRL, SKIP, ALTR,
    FSQ_TX, FSQ_DIR, FSQ_UND, FSQ_XMT, FSQ_LF, FSQ_NRM
  };
};
