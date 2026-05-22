// RX-only build doesn't open file pickers. mfsk.cxx includes fileselect.h
// for TX image loading; provide an empty header so the include resolves.
#pragma once
