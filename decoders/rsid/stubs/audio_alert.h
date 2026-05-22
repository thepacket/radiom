#pragma once
#include <string>
struct AudioAlertStub {
  void alert(const std::string&) {}
  void alert(const char*) {}
};
extern AudioAlertStub* audio_alert;
inline void audio_alert_close() {}
