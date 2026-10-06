/* BrowSDR receive-only adapter for kgoba/ft8_lib (MIT). */
#include <stdlib.h>
#include <string.h>
#include <common/monitor.h>
#include <ft8/message.h>

#define MAX_RESULTS 100
#define HASH_SIZE 256
typedef struct { float sync, dt, hz; char text[40]; } result_t;
static monitor_t monitor;
static result_t results[MAX_RESULTS];
static struct { uint32_t hash; char call[12]; } calls[HASH_SIZE];
static unsigned next_call;

static void save_call(const char *call, uint32_t hash) {
    for (int i = 0; i < HASH_SIZE; i++) {
        if (calls[i].call[0] && calls[i].hash == hash) return;
    }
    unsigned i = next_call++ % HASH_SIZE;
    calls[i].hash = hash;
    strncpy(calls[i].call, call, 11);
    calls[i].call[11] = 0;
}
static bool lookup_call(ftx_callsign_hash_type_t type, uint32_t hash, char *call) {
    int shift = type == FTX_CALLSIGN_HASH_10_BITS ? 12 : type == FTX_CALLSIGN_HASH_12_BITS ? 10 : 0;
    for (int i = 0; i < HASH_SIZE; i++) {
        if (calls[i].call[0] && (calls[i].hash >> shift) == hash) {
            strcpy(call, calls[i].call);
            return true;
        }
    }
    return false;
}
static ftx_callsign_hash_interface_t hash_if = { lookup_call, save_call };

void ft8_init(void) {
    monitor_config_t config = { 200, 3000, 12000, 2, 2, FTX_PROTOCOL_FT8 };
    monitor_init(&monitor, &config);
}
result_t *ft8_results(void) { return results; }
void ft8_reset(void) { memset(calls, 0, sizeof(calls)); next_call = 0; }

int ft8_decode(const float *audio, int length) {
    if (length != 180000) return -1;
    monitor_reset(&monitor);
    memset(monitor.last_frame, 0, monitor.nfft * sizeof(float));
    for (int pos = 0; pos + monitor.block_size <= length; pos += monitor.block_size)
        monitor_process(&monitor, audio + pos);
    ftx_candidate_t candidates[300];
    int count = ftx_find_candidates(&monitor.wf, 300, candidates, 10);
    ftx_message_t decoded[MAX_RESULTS];
    int found = 0;
    for (int i = 0; i < count && found < MAX_RESULTS; i++) {
        ftx_message_t message;
        ftx_decode_status_t status;
        if (!ftx_decode_candidate(&monitor.wf, &candidates[i], 30, &message, &status)) continue;
        bool duplicate = false;
        for (int j = 0; j < found; j++)
            if (!memcmp(decoded[j].payload, message.payload, sizeof(message.payload))) duplicate = true;
        if (duplicate) continue;
        ftx_message_offsets_t offsets;
        result_t *result = &results[found];
        memset(result, 0, sizeof(*result));
        if (ftx_message_decode(&message, &hash_if, result->text, &offsets) != FTX_MESSAGE_RC_OK) continue;
        decoded[found] = message;
        result->sync = candidates[i].score;
        result->dt = (candidates[i].time_offset + (float)candidates[i].time_sub / 2) * monitor.symbol_period - 0.5f;
        result->hz = (monitor.min_bin + candidates[i].freq_offset + (float)candidates[i].freq_sub / 2) / monitor.symbol_period;
        found++;
    }
    return found;
}
