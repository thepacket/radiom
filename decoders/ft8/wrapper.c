/*
 * Flat C API around kgoba/ft8_lib (current "ftx" naming) so JavaScript can
 * call into it without having to deal with structs.
 *
 * Lifecycle per 15 s window:
 *   1. ft8_decode_window(samples, n_samples, sample_rate, is_ft4)
 *   2. ft8_message_count() / ft8_message_text(i) / freq(i) / snr(i) / dt(i)
 *   3. ft8_clear() before the next window.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

#include "ft8/decode.h"
#include "ft8/message.h"
#include "ft8/constants.h"
#include "common/monitor.h"

#define MAX_RESULTS 64

typedef struct {
    char  text[FTX_MAX_MESSAGE_LENGTH + 1];
    float freq_hz;
    float dt_s;
    float snr_db;
} ft8_result_t;

static ft8_result_t g_results[MAX_RESULTS];
static int g_count = 0;

EMSCRIPTEN_KEEPALIVE
void ft8_clear(void) { g_count = 0; }

EMSCRIPTEN_KEEPALIVE
int ft8_message_count(void) { return g_count; }

EMSCRIPTEN_KEEPALIVE
const char* ft8_message_text(int i) {
    if (i < 0 || i >= g_count) return "";
    return g_results[i].text;
}

EMSCRIPTEN_KEEPALIVE
float ft8_message_freq(int i) {
    if (i < 0 || i >= g_count) return 0.0f;
    return g_results[i].freq_hz;
}

EMSCRIPTEN_KEEPALIVE
float ft8_message_snr(int i) {
    if (i < 0 || i >= g_count) return 0.0f;
    return g_results[i].snr_db;
}

EMSCRIPTEN_KEEPALIVE
float ft8_message_dt(int i) {
    if (i < 0 || i >= g_count) return 0.0f;
    return g_results[i].dt_s;
}

EMSCRIPTEN_KEEPALIVE
int ft8_decode_window(const float* samples, int n_samples, int sample_rate, int is_ft4) {
    g_count = 0;

    monitor_config_t cfg;
    cfg.f_min = 100.0f;
    cfg.f_max = 3000.0f;
    cfg.sample_rate = sample_rate;
    cfg.time_osr = 2;
    cfg.freq_osr = 2;
    cfg.protocol = is_ft4 ? FTX_PROTOCOL_FT4 : FTX_PROTOCOL_FT8;

    monitor_t mon;
    monitor_init(&mon, &cfg);

    int block_size = mon.block_size;
    int n_blocks = n_samples / block_size;
    for (int i = 0; i < n_blocks; i++) {
        monitor_process(&mon, samples + i * block_size);
    }

    enum { kMin_score = 10, kMax_candidates = 140, kLDPC_iter = 25 };
    ftx_candidate_t cand_list[kMax_candidates];
    int n_cands = ftx_find_candidates(&mon.wf, kMax_candidates, cand_list, kMin_score);

    // Inline de-dup by message hash + payload — same idea as demo/decode_ft8.c.
    ftx_message_t decoded[MAX_RESULTS];
    ftx_message_t* slot[MAX_RESULTS];
    for (int i = 0; i < MAX_RESULTS; i++) slot[i] = NULL;

    for (int idx = 0; idx < n_cands && g_count < MAX_RESULTS; idx++) {
        const ftx_candidate_t* cand = &cand_list[idx];

        float freq_hz = (mon.min_bin + cand->freq_offset + (float)cand->freq_sub / mon.wf.freq_osr) / mon.symbol_period;
        float time_s  = (cand->time_offset + (float)cand->time_sub / mon.wf.time_osr) * mon.symbol_period;

        ftx_message_t msg;
        ftx_decode_status_t st;
        if (!ftx_decode_candidate(&mon.wf, cand, kLDPC_iter, &msg, &st)) continue;

        // Hash-table-style de-dup.
        int h = msg.hash % MAX_RESULTS;
        int dup = 0, placed = 0;
        for (int t = 0; t < MAX_RESULTS && !placed && !dup; t++) {
            int p = (h + t) % MAX_RESULTS;
            if (slot[p] == NULL) {
                memcpy(&decoded[p], &msg, sizeof msg);
                slot[p] = &decoded[p];
                placed = 1;
            } else if (slot[p]->hash == msg.hash &&
                       0 == memcmp(slot[p]->payload, msg.payload, sizeof msg.payload)) {
                dup = 1;
            }
        }
        if (dup || !placed) continue;

        char text[FTX_MAX_MESSAGE_LENGTH];
        text[0] = '\0';
        ftx_message_offsets_t offsets;
        if (ftx_message_decode(&msg, NULL, text, &offsets) != FTX_MESSAGE_RC_OK) {
            // Couldn't unpack cleanly — still expose the raw status.
            snprintf(text, sizeof text, "<unpack err>");
        }

        ft8_result_t* r = &g_results[g_count++];
        strncpy(r->text, text, sizeof r->text - 1);
        r->text[sizeof r->text - 1] = '\0';
        r->freq_hz = freq_hz;
        r->dt_s    = time_s;
        r->snr_db  = cand->score * 0.5f; // demo's rough estimate
    }

    monitor_free(&mon);
    return g_count;
}
