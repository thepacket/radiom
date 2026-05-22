// Minimal FLTK stub. RX-only build doesn't render any GUI; we only need
// the type names referenced in fldigi headers, plus a few methods that
// pass-through silently so the .cxx compiles without modification.
#pragma once

struct Fl_Widget {
  void show()             {}
  void hide()             {}
  void redraw()           {}
  void label(const char*) {}
  void copy_label(const char*) {}
  void resize(int,int,int,int) {}
  void value(int)         {}
  int  value()            { return 0; }
  void deactivate()       {}
  void activate()         {}
  void color(int)         {}
};
struct Fl_Double_Window : Fl_Widget {
  Fl_Double_Window(int=0, int=0, int=0, int=0, const char* =nullptr) {}
  bool visible() const    { return false; }
};
struct Fl_Box     : Fl_Widget {};
struct Fl_Button  : Fl_Widget {};
struct Fl_Image {};
struct Fl_Shared_Image : Fl_Image {};
