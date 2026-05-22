// Stub: fldigi user-preferences, only the fields PSK actually reads.
#pragma once
#include <string>

struct progdefaults_t {
  int    PSKsweetspot         = 1000;
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

  // Olivia ────────────────────────────────────────────────────────
  int    oliviatones        = 5;     // index into 2/4/8/16/32/64/128/256
  int    oliviabw           = 2;     // index into 125/250/500/1000/2000
  int    oliviasinteg       = 4;     // S/N integration count
  int    oliviasmargin      = 8;     // search margin (tones)
  bool   olivia_start_tones = false;
  bool   olivia8bit         = false;

  // Contestia ─────────────────────────────────────────────────────
  int    contestiatones        = 2;     // index into 2/4/8/16/32/64
  int    contestiabw           = 1;     // index into 125/250/500/1000/2000
  int    contestiasinteg       = 4;
  int    contestiasmargin      = 8;
  bool   contestia_start_tones = false;
  bool   contestia8bit         = false;
  bool   rx_lowercase          = false;
};

extern progdefaults_t progdefaults;
