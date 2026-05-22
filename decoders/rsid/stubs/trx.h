#pragma once
// rsid.cxx invokes ENSURE_THREAD(TRX_TID) inside cRsId::apply. We run
// single-threaded → no-op the assertion + provide the symbolic id.
#define TRX_TID                 0
#define ENSURE_THREAD(...)      ((void)0)
#define ENSURE_NOT_THREAD(...)  ((void)0)
