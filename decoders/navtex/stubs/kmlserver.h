// Stub: fldigi's KML output for Google Earth integration.
// We don't emit KML in our headless decoder.
#pragma once
#include <string>

#include "coordinate.h"

class KmlServer {
public:
  struct CustomDataT {
    void Push(const char*, const std::string&) {}
    template <class T> void Push(const char*, T) {}
  };
  static KmlServer* GetInstance() { static KmlServer s; return &s; }
  // fldigi's signature passes a CoordinateT::Pair, not lat+long+alt.
  void Broadcast(const char*, time_t, const CoordinateT::Pair&, double,
                 const std::string&, const std::string&,
                 const std::string&, const CustomDataT&) {}
};
