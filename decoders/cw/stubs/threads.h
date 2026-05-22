// Stub for fldigi's pthread mutex wrappers. cw.cxx doesn't use these
// directly, but modem.h declares some thread types we need to satisfy.
#pragma once
#include <pthread.h>
#include <semaphore.h>
