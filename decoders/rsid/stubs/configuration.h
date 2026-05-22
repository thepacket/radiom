// Stub: fldigi's user-preferences struct, fields stripped to those cw.cxx
// actually reads, with defaults that match fldigi's out-of-the-box config.
#pragma once
#include <string>
#include <bitset>
#include "globals.h"

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
  // ── RSID receiver ────────────────────────────────────────────────
  // Search the entire spectrum (we have no waterfall to centre around).
  bool        rsidWideSearch                  = true;
  int         rsid_min_bw                     = 500;
  // 0 = exact code match, >0 = allow that many symbol errors (Hamming
  // distance). fldigi defaults to 1; we keep it tighter to cut FPs.
  int         RsID_label_type                 = 0;
  // libsamplerate converter type (0 = SRC_SINC_BEST_QUALITY, 4 = LINEAR).
  // 4 is plenty since we feed the decoder at exactly 11025 Hz (ratio = 1).
  int         sample_converter                = 4;
  // detection-time toggles. We want all detections, no auto-disable, no
  // automatic mode switching (the host decides what to do with the event).
  std::bitset<NUM_MODES> rsid_rx_modes        = std::bitset<NUM_MODES>().set();
  std::bitset<NUM_MODES> rsid_tx_modes        = std::bitset<NUM_MODES>();
  bool        ENABLE_RSID_MATCH               = false;
  std::string RSID_MATCH                      = "";
  bool        rsid_auto_disable               = false;
  bool        rsid_squelch                    = false;
  bool        rsid_notify_only                = true;   // no in-decoder retune
  bool        disable_rsid_warning_dialog_box = true;
  bool        rsid_eot_squelch                = false;
  bool        rsid_mark                       = false;
  bool        retain_freq_lock                = false;
  bool        disable_rsid_freq_change        = false;
  bool        rsid_post                       = true;
  // ── modem-tab settings rsid.cxx writes when applying a detected
  //    mode. We never read these (host owns mode switching), but the
  //    fields must exist so the assignments compile. ────────────────
  int         rtty_baud                       = 1;
  int         rtty_bits                       = 0;
  int         rtty_shift                      = 3;
  int         oliviatones                     = 1;
  int         oliviabw                        = 1;
  int         contestiatones                  = 1;
  int         contestiabw                     = 1;
  bool        DOMINOEX_FEC                    = false;
};

extern progdefaults_t progdefaults;
