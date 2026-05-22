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
  void Bandwidth(int) {}
  // wefax.cxx samples spectral power density inside its bandwidth.
  double powerDensity(double /*center*/, double /*bw*/) { return 1.0; }
  // wefax.cxx searches an APT carrier across N bandwidth windows passed
  // as a 2D int array of [lo,hi] pairs. Returning a centre-band value
  // tells fldigi the carrier already sits at our chosen sub-carrier.
  double powerDensityMaximum(int /*nbsweet*/, const int (*/*bws*/)[2]) { return 1900.0; }
  long long rfcarrier() { return 0; }
private:
  int  carrier = 1000;
  bool usb     = true;
  bool reverse = false;
};

extern waterfall* wf;
