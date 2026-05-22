// Stub for fldigi's pthread mutex wrappers. cw.cxx doesn't use these
// directly, but modem.h declares some thread types we need to satisfy.
#pragma once
#include <pthread.h>
#include <semaphore.h>

// RX-only build is single-threaded; guard_lock is a no-op.
struct guard_lock {
  guard_lock(pthread_mutex_t*) {}
  ~guard_lock() {}
};
