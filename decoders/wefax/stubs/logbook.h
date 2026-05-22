// Stub: fldigi's QSO logbook. wefax.cxx writes one record per saved
// chart when progdefaults.WEFAX_AdifLog is true (we keep it false, but
// the symbols still need to link).
#pragma once
#include <string>

enum {
  CALL = 1, NAME, TX_PWR, ADIF_MODE, NOTES,
};

class cQsoRec {
public:
  cQsoRec() {}
  void putField(int, const char*)        {}
  void putField(int, const std::string&) {}
  void setDateTime(bool)                 {}
  void setFrequency(double)              {}
};

struct QsodbStub {
  void qsoNewRec(cQsoRec*) {}
  void isdirty(int)        {}
};
extern QsodbStub qsodb;

struct AdifFileStub { void writeLog(const char*, QsodbStub*) {} };
extern AdifFileStub adifFile;

extern std::string logbook_filename;
extern void loadBrowser(bool);
