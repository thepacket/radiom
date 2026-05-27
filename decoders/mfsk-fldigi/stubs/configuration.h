// Stub: fldigi user-preferences, fields stripped to those mfsk + neighbors
// actually read.
#pragma once
#include <string>

struct progdefaults_t {
  int    PSKsweetspot         = 1500;
  bool   PSKmailSweetSpot     = false;
  bool   StartAtSweetSpot     = true;
  bool   Pskmails2nreport     = false;
  double ACQsn                = 9.0;
  int    SearchRange          = 200;
  double ServerACQsn          = 9.0;
  int    ServerAFCrange       = 100;
  double ServerCarrier        = 1500.0;
  double ServerOffset         = 0.0;
  double StatusTimeout        = 5.0;
  bool   StatusDim            = false;
  bool   pskpilot             = false;
  double pilot_power          = -30.0;
  bool   report_when_visible  = false;
  int    HighFreqCutoff       = 3000;
  int    LowFreqCutoff        = 100;
  int    VIEWERchannels       = 30;
  int    VIEWERtimeout        = 60;
  // mfsk image-save (no-op in RX-only build).
  std::string PicsDir         = "";
  // Force lowercase on RX. Used by throb (and some other modes) to
  // normalize decoded characters. Default false → pass-through.
  bool   rx_lowercase         = false;
};

extern progdefaults_t progdefaults;
