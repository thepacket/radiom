// Stub for fldigi's threading primitives. wefax.cxx uses `syncobj`
// (recursive mutex + condition variable) and `guard_lock` (RAII mutex
// scope). Single-threaded build → all no-ops, but the shape has to
// match fldigi's expected interface (`mtxp()`, `wait()` returning bool).
#pragma once
#include <pthread.h>
#include <semaphore.h>

class syncobj {
public:
  syncobj()  {}
  ~syncobj() {}
  void   lock()             {}
  void   unlock()           {}
  bool   wait(double = 0)   { return true; }
  void   signal()           {}
  pthread_mutex_t* mtxp()   { return &m_mtx; }
private:
  pthread_mutex_t m_mtx = PTHREAD_MUTEX_INITIALIZER;
};

class guard_lock {
public:
  explicit guard_lock(pthread_mutex_t*) {}
  explicit guard_lock(syncobj*)         {}
  explicit guard_lock(syncobj&)         {}
  ~guard_lock() {}
};
