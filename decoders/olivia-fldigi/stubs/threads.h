// Stub for fldigi's pthread mutex wrappers. RX-only build is single-
// threaded, so guard_lock is a no-op and the mutex types just exist.
#pragma once
#include <pthread.h>
#include <semaphore.h>

struct guard_lock {
  guard_lock(pthread_mutex_t*) {}
  ~guard_lock() {}
};
