// Stub: fldigi's REQ() marshals a call onto the GUI thread. We're
// single-threaded and have no GUI — call directly.
#pragma once
#define REQ(fn, ...)        ((void)0)
#define REQ_SYNC(fn, ...)   ((void)0)
#define REQ_DROP(fn, ...)   ((void)0)
#define REQ_ASYNC(fn, ...)  ((void)0)
