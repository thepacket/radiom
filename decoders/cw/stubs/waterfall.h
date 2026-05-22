// Stub: fldigi's waterfall widget. cw.cxx reads wf->Carrier(), wf->USB(),
// wf->Reverse() during demodulation. We provide fixed values from the
// vendored modem state.
#pragma once

class waterfall {
public:
  int Carrier() { return carrier; }
  void Carrier(int c) { carrier = c; }
  bool USB() { return usb; }
  void USB(bool u) { usb = u; }
  bool Reverse() { return reverse; }
  void Reverse(bool r) { reverse = r; }
  void set_modeBW(int) {}
private:
  int  carrier = 1000;
  bool usb     = true;
  bool reverse = false;
};

extern waterfall* wf;
