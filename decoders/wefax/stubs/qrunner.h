// wefax build: REQ() must actually invoke its target. fldigi's wefax.cxx
// routes pixel emission through `REQ(wefax_pic::update_rx_pic_bw, …)`,
// which is the only path by which decoded image data leaves the modem.
// (Note: the cw build's stubs/qrunner.h defines REQ as a no-op, since
// cw only uses it to push GUI updates we don't care about.)
#pragma once
#define REQ(fn, ...)        (fn(__VA_ARGS__))
#define REQ_SYNC(fn, ...)   (fn(__VA_ARGS__))
#define REQ_DROP(fn, ...)   (fn(__VA_ARGS__))
#define REQ_ASYNC(fn, ...)  (fn(__VA_ARGS__))
#define REQ_FLUSH(...)      ((void)0)
#define GET_THREAD_ID()     (0)
