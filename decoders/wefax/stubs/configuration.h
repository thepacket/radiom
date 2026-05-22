// Stub: fldigi's user-preferences struct, fields stripped to those cw.cxx
// actually reads, with defaults that match fldigi's out-of-the-box config.
#pragma once
#include <string>

struct progdefaults_t {
  // ── CW receiver ──────────────────────────────────────────────────
  bool        CWtrack            = true;     // adaptive WPM tracking
  int         CWspeed            = 18;       // initial WPM
  int         defCWspeed         = 18;
  int         CWlowerlimit       = 5;
  int         CWupperlimit       = 50;
  double      CWbandwidth        = 150.0;    // matched-filter BW (Hz)
  int         CWrange            = 10;       // ± range about CWspeed (WPM)
  // CWlower / CWupper are the adaptive Schmitt-trigger thresholds the
  // decoder writes back into progdefaults at runtime — they need to be
  // floats so float values aren't truncated to zero on assignment.
  double      CWlower            = 0.0;
  double      CWupper            = 0.0;
  bool        CWusefarnsworth    = false;
  bool        CWfarnsworth       = false;
  int         CWsweetspot        = 800;      // audio "sweet spot" Hz
  bool        StartAtSweetSpot   = false;
  bool        CWmfilt            = true;     // matched filter on
  double      CWnoise            = 0.0;
  bool        CWuseSOMdecoding   = false;
  bool        CW_use_paren       = false;
  char        CW_noise           = ' ';   // marker for unrecognized symbol
  double      CWdash2dot         = 3.0;
  std::string CW_prosigns        = "()<>[]{}";  // length must be 9 for morse to map them
  bool        CW_prosign_display = false;
  // Accented-character options (Continental Morse extensions)
  bool        A_umlaut = false, A_aelig = false, A_ring = false;
  bool        C_cedilla = false, E_grave = false, E_acute = false;
  bool        O_acute = false, O_umlaut = false, O_slash = false;
  bool        N_tilde = false, U_umlaut = false, U_circ = false;
  // Optional ASCII punctuation
  bool        CW_backslash = false, CW_single_quote = false, CW_dollar_sign = false;
  bool        CW_open_paren = false, CW_close_paren = false;
  bool        CW_colon = false, CW_semi_colon = false;
  bool        CW_underscore = false, CW_at_symbol = false, CW_exclamation = false;
  int         cwrx_attack        = 1;        // 0=fast 1=med 2=slow
  int         cwrx_decay         = 1;        // 0=fast 1=med 2=slow
  bool        rx_lowercase       = false;
  // ── CW transmitter (unused but referenced) ───────────────────────
  double      CWdash             = 3.0;
  double      CWrisetime         = 4.0;
  double      CWkeycomp          = 0.0;
  double      CW_cal_speed       = 0.0;
  int         CWpre              = 0;
  int         CWpost             = 0;
  bool        QSK                = false;
  double      QSKamp             = 0.0;
  double      QSKfrequency       = 1000.0;
  double      QSKrisetime        = 4.0;
  int         QSKshape           = 0;
  bool        pretone            = false;
  bool        CW_KEYLINE         = false;
  bool        CW_KEYLINE_on_cat_port = false;
  bool        CW_KEYLINE_on_ptt_port = false;
  std::string CW_KEYLINE_serial_port_name = "";
  int         CATkeying_compensation = 0;
  bool        PTT_KEYLINE        = false;
  bool        use_FLRIGkeying    = false;
  bool        use_ICOMkeying     = false;
  bool        use_KNWDkeying     = false;
  bool        use_YAESUkeying    = false;
  bool        use_ELCTkeying     = false;
  int         BaudRate           = 9600;
  // ── WEFAX receiver ──────────────────────────────────────────────
  bool        WEFAX_AdifLog      = false;
  int         WEFAX_Center       = 1900;          // sub-carrier centre Hz
  int         WEFAX_Shift        = 800;           // FM peak deviation Hz
  int         WEFAX_MaxRows      = 2300;
  int         wefax_correlation       = 4;
  int         wefax_correlation_rows  = 16;
  int         wefax_filter            = 0;         // 0=Narrow 1=Medium 2=Wide
};

extern progdefaults_t progdefaults;
