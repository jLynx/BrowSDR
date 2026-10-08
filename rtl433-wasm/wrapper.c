/* BrowSDR streaming adapter for rtl_433 (GPL-2.0-or-later). */
#include <emscripten.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "rtl_433.h"
#include "r_private.h"
#include "r_api.h"
#include "r_flow.h"
#include "r_device.h"
#include "data.h"
#include "pulse_detect_fsk.h"

#define BLOCK_SAMPLES 32768

EM_JS(void, emit_decoded, (const char *json), {
    if (Module.onDecoded) Module.onDecoded(UTF8ToString(json));
});

static void output_json(data_output_t *output, data_t *data)
{
    (void)output;
    char *json = data_print_jsons_dup(data);
    if (json) { emit_decoded(json); free(json); }
}

/* One WASM instance per VFO. No native SDR, file, or network input is opened. */
static r_cfg_t *cfg;
static int16_t iq_block[BLOCK_SAMPLES * 2];

int rtl433_init(unsigned rate, unsigned frequency, const char *protocols)
{
    if (cfg) return 0;
    cfg = r_create_cfg();
    cfg->samp_rate = rate;
    cfg->center_frequency = frequency;
    cfg->conversion_mode = CONVERT_SI;
    cfg->report_time = REPORT_TIME_OFF;
    cfg->report_protocol = 1;
    cfg->report_meta = 1;
    cfg->verbosity = 0;
    data_output_t *output = calloc(1, sizeof(*output));
    if (!output) return 0;
    output->output_print = output_json;
    list_push(&cfg->output_handler, output);
    if (protocols && *protocols) {
        char *copy = strdup(protocols);
        char *id = strtok(copy, ",");
        while (id) {
            int num = atoi(id);
            if (num > 0 && num <= cfg->num_r_devices)
                register_protocol(cfg, &cfg->devices[num - 1], NULL);
            id = strtok(NULL, ",");
        }
        free(copy);
    } else {
        register_all_protocols(cfg, 0);
    }
    struct dm_state *dm = cfg->demod;
    dm->sample_size = 4; /* signed 16-bit complex IQ */
    dm->raw_handler = &cfg->raw_handler;
    dm->samp_rate = rate;
    dm->center_frequency = frequency;
    dm->fsk_pulse_detect_mode = frequency > FSK_PULSE_DETECTOR_LIMIT ? FSK_PULSE_DETECT_NEW : FSK_PULSE_DETECT_OLD;
    for (void **it = dm->r_devs.elems; it && *it; ++it)
        if (((r_device *)*it)->modulation >= FSK_DEMOD_MIN_VAL) dm->enable_FM_demod = 1;
    pulse_detect_set_levels(dm->pulse_detect, dm->use_mag_est, dm->level_limit, dm->min_level, dm->min_snr, 0);
    reset_sdr_flow(cfg);
    return (int)dm->r_devs.len;
}

int rtl433_process(const float *iq, unsigned values)
{
    if (!cfg || values % 2) return -1;
    int events = 0;
    for (unsigned offset = 0; offset < values;) {
        unsigned count = values - offset;
        if (count > BLOCK_SAMPLES * 2) count = BLOCK_SAMPLES * 2;
        for (unsigned i = 0; i < count; i++) {
            float value = iq[offset + i];
            if (!isfinite(value)) value = 0;
            value = fmaxf(-1, fminf(1, value));
            iq_block[i] = (int16_t)lrintf(value * 32767.0f);
        }
        events += push_sdr_flow(cfg, (unsigned char *)iq_block, count * sizeof(int16_t));
        offset += count;
    }
    return events;
}

int rtl433_flush(void) { return cfg ? flush_sdr_flow(cfg) : 0; }
unsigned rtl433_protocol_count(void) { return cfg ? cfg->num_r_devices : 0; }
const char *rtl433_protocol_name(unsigned id) { return cfg && id && id <= cfg->num_r_devices ? cfg->devices[id - 1].name : ""; }
int rtl433_protocol_disabled(unsigned id) { return cfg && id && id <= cfg->num_r_devices ? cfg->devices[id - 1].disabled : 1; }

void rtl433_destroy(void)
{
    if (!cfg) return;
    /* Release only resources this adapter creates. Avoid native CLI teardown,
       which pulls hardware/socket/filesystem code into the WASM binary. */
    list_free_elems(&cfg->demod->r_devs, (list_elem_free_fn)free_protocol);
    list_free_elems(&cfg->demod->dumper, free);
    pulse_detect_free(cfg->demod->pulse_detect);
    list_free_elems(&cfg->output_handler, free);
    list_free_elems(&cfg->in_files, NULL);
    free(cfg->demod);
    free(cfg->devices);
    free(cfg);
    cfg = NULL;
}
