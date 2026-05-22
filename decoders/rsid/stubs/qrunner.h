// rsid.cxx routes detection events through REQ(init_modem, mode, freq) and
// pushes mode-tab GUI updates as REQ(&set_xxx_tab_widgets). We direct-invoke
// in both forms via a small variadic dispatcher (the dispatcher accepts
// either a function name or its address — both decay to the same pointer).
#pragma once
#include <utility>

template <class F, class... A>
static inline void _req_invoke(F&& f, A&&... a) { f(std::forward<A>(a)...); }

#define REQ(fn, ...)        _req_invoke(fn, ##__VA_ARGS__)
#define REQ_SYNC(fn, ...)   _req_invoke(fn, ##__VA_ARGS__)
#define REQ_DROP(fn, ...)   _req_invoke(fn, ##__VA_ARGS__)
#define REQ_ASYNC(fn, ...)  _req_invoke(fn, ##__VA_ARGS__)
#define REQ_FLUSH(...)      ((void)0)
#define GET_THREAD_ID()     (0)
