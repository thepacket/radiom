// RX-only stub for fldigi's MFSK image (Pic) feature. The whole TX image
// path is gutted; mfsk.cxx still references a handful of symbols which we
// satisfy with no-op definitions here.

#include "mfsk.h"

Fl_Double_Window* picTxWin = nullptr;
int txSPP = 8;

void createRxViewer()                  {}
void createTxViewer()                  {}
void deleteRxViewer()                  {}
void deleteTxViewer()                  {}
void showRxViewer(int, int)            {}
void showTxViewer(int, int)            {}
void TxViewerResize(int, int)          {}
void updateRxPic(unsigned char, int)   {}
void updateTxPic(unsigned char)        {}
void setpicture_link(mfsk*)            {}
