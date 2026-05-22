// Stub: fldigi's waterfall widget. PSK reads Carrier() and powerDensity().
// powerDensity() returns ~0 so findsignal()'s SNR test never fires; AFC
// drives the actual carrier lock.
#pragma once

#define WF_FFTLEN 8192
extern int IMAGE_WIDTH;

class waterfall {
public:
  int  Carrier()        { return carrier; }
  void Carrier(int c)   { carrier = c; }
  bool USB()            { return usb; }
  void USB(bool u)      { usb = u; }
  bool Reverse()        { return reverse; }
  void Reverse(bool r)  { reverse = r; }
  void set_modeBW(int)  {}
  double powerDensity(double, double) { return 1e-9; }
  // pskeval samples the waterfall FFT bins; we have no FFT, return 0.
  double Pwr(int) { return 0.0; }
private:
  int  carrier = 1000;
  bool usb     = true;
  bool reverse = false;
};

extern waterfall* wf;
