// Stub: fldigi's CSV-style record loader (used here for the NAVTEX
// station catalog). Headless decoder doesn't load the catalog, so the
// template can be a near-empty shell.
#pragma once
#include <string>

template <class Catalog>
class RecordLoader {
public:
  static Catalog& InstCatalog() { static Catalog c; return c; }
  bool ReadRecord(std::istream&) { return false; }
  std::string Url()  const { return ""; }
  std::string Name() const { return ""; }
  std::string base_filename() const { return ""; }
  // fldigi's RecordLoader::storage_filename returns (path, exists?).
  std::pair<std::string, bool> storage_filename() const { return {"", false}; }
  bool LoadAndRegister() { return false; }
};
