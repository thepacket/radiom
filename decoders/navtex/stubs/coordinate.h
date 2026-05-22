// Stub: fldigi's geographic-coordinate helpers. NAVTEX messages have
// area codes (B1B2B3B4) that fldigi optionally maps to lat/long. We
// don't need the geo features for headless decode — the parsed text is
// what matters. Provide just enough for navtex.cxx to compile.
#pragma once
#include <iosfwd>
#include <ostream>
#include <string>

// Stub — matches fldigi's coordinate.h interface closely enough for
// navtex.cxx to compile. We don't use the geo features at runtime.
class CoordinateT {
public:
  CoordinateT() : m_dec(0.0) {}
  CoordinateT(double v) : m_dec(v) {}
  CoordinateT(const std::string&) : m_dec(0.0) {}
  double  decimal_value() const { return m_dec; }
  double& decimal_value()       { return m_dec; }
  std::string to_string() const { return ""; }
  std::string FormatString() const { return ""; }
  std::string Lon() const { return ""; }
  std::string Lat() const { return ""; }
  bool empty() const { return true; }
  bool is_lon() const { return false; }
  class Pair;
private:
  double m_dec;
};

class CoordinateT::Pair {
public:
  Pair() {}
  Pair(const std::string&) {}
  Pair(const CoordinateT&, const CoordinateT&) : m_lon(), m_lat() {}
  // Both const-and-non-const overloads — navtex.cxx feeds the non-const
  // variants to read_until_delim() which needs an lvalue reference.
  CoordinateT  longitude() const { return m_lon; }
  CoordinateT  latitude()  const { return m_lat; }
  CoordinateT& longitude()       { return m_lon; }
  CoordinateT& latitude()        { return m_lat; }
  std::string  locator() const { return ""; }
  std::string  to_string() const { return ""; }
  bool empty() const { return true; }
  // Great-circle distance helper (km). Returns 0 in our stub.
  double distance(const Pair&) const { return 0.0; }
private:
  CoordinateT m_lon, m_lat;
};

// Stream output for CoordinateT::Pair — a couple of fldigi spots feed it
// into stringstream. Produces an empty string to keep messages clean.
inline std::ostream& operator<<(std::ostream& os, const CoordinateT::Pair&) { return os; }
// Stream input for CoordinateT — fldigi's read_until_delim instantiates
// `sstrm >> ref` for both std::string and CoordinateT. Just consume to
// next whitespace and discard.
#include <istream>
inline std::istream& operator>>(std::istream& is, CoordinateT&) {
  std::string tmp; is >> tmp; return is;
}
