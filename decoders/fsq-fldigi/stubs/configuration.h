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

  // MT63 ──────────────────────────────────────────────────────────
  bool   mt63_8bit            = false;
  bool   mt63_at500           = false;
  bool   mt63_centered        = false;
  bool   mt63_rx_integration  = true;   // long integration
  int    mt63_tone_duration   = 5;
  bool   mt63_twotones        = true;
  bool   mt63_usetones        = false;

  // FSQ ───────────────────────────────────────────────────────────
  int    fsqbaud              = 300;       // baud × 100 (3 baud default)
  int    fsq_movavg           = 1;
  int    fsqhits              = 4;
  bool   fsq_directed         = false;
  bool   fsq_lowercase        = true;
  bool   fsq_sounder          = false;
  bool   fsq_audit_log        = false;
  bool   fsq_heard_log        = false;
  bool   fsq_enable_audit_log = false;
  bool   fsq_enable_heard_log = false;
  std::string fsqQTCtext      = "";
  bool   add_fsq_msg_dt       = false;
  bool   always_append        = false;
  int    fsq_time_out         = 5;
  int    fsq_notify_time_out  = 5;
  std::string myCall          = "";
  std::string myQth           = "";
};

extern progdefaults_t progdefaults;
