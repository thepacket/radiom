// Flat C API around Pawel Jalocha's MFSK receiver (the same code fldigi
// uses for Olivia + Contestia). Header-only, no fldigi framework needed.
//
// Lifecycle:
//   olivia_init(tones, bandwidth, sampleRate)   -- create the receiver
//   olivia_feed(samples, n)                     -- push audio (float)
//   olivia_get_text()                           -- pull decoded chars
//                                                 (UTF-8, accumulated)
//   olivia_clear()                              -- reset the text buffer

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

#include "jalocha/pj_mfsk.h"

static MFSK_Receiver<double>* g_rx = nullptr;
// Output buffer for accumulated decoded characters between get_text calls.
static char* g_out = nullptr;
static size_t g_out_cap = 0;
static size_t g_out_len = 0;

extern "C" {

EMSCRIPTEN_KEEPALIVE
void olivia_init_at(int tones, int bandwidth, int sample_rate, int first_carrier_hz);

EMSCRIPTEN_KEEPALIVE
void olivia_init(int tones, int bandwidth, int sample_rate) {
    olivia_init_at(tones, bandwidth, sample_rate, 1500);
}

EMSCRIPTEN_KEEPALIVE
void olivia_init_at(int tones, int bandwidth, int sample_rate, int first_carrier_hz) {
    delete g_rx;
    g_rx = new MFSK_Receiver<double>();
    g_rx->Tones = tones;
    g_rx->Bandwidth = bandwidth;
    g_rx->SampleRate = 8000.0;            // internal Olivia rate
    g_rx->InputSampleRate = sample_rate;  // browser-supplied rate
    // Place the first MFSK tone at the user-chosen Hz. With internal
    // SampleRate=8000 and SymbolLen tied to (BitsPerSymbol, Bandwidth),
    // FirstCarrierMultiplier × 500 = first-tone frequency in Hz.
    g_rx->FirstCarrierMultiplier = (float)first_carrier_hz / 500.0f;
    g_rx->Reverse = 0;
    if (g_rx->Preset() < 0) {
        delete g_rx; g_rx = nullptr;
    }
    if (!g_out) { g_out_cap = 4096; g_out = (char*)malloc(g_out_cap); }
    g_out_len = 0;
}

EMSCRIPTEN_KEEPALIVE
void olivia_feed(const double* samples, int n) {
    if (!g_rx) return;
    g_rx->Process((double*)samples, n);
    // Drain decoded chars into our buffer.
    uint8_t c;
    while (g_rx->GetChar(c) > 0) {
        if (g_out_len + 1 >= g_out_cap) {
            g_out_cap *= 2;
            g_out = (char*)realloc(g_out, g_out_cap);
        }
        g_out[g_out_len++] = (char)c;
    }
}

EMSCRIPTEN_KEEPALIVE
const char* olivia_get_text() {
    if (!g_out) return "";
    if (g_out_len + 1 >= g_out_cap) {
        g_out_cap *= 2;
        g_out = (char*)realloc(g_out, g_out_cap);
    }
    g_out[g_out_len] = 0;
    return g_out;
}

EMSCRIPTEN_KEEPALIVE
void olivia_clear() {
    g_out_len = 0;
}

EMSCRIPTEN_KEEPALIVE
int olivia_text_length() {
    return (int)g_out_len;
}

} // extern "C"
