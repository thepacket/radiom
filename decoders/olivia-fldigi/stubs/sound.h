// Stub: fldigi's audio I/O abstraction. Receive-only build doesn't drive
// the sound card; we only need the type and SCBLOCKSIZE constant.
#pragma once
#ifndef SCBLOCKSIZE
#define SCBLOCKSIZE 512
#endif
class SoundBase {};
