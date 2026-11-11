#include <emscripten.h>
#include <stdlib.h>
#include "private.h"

pthread_mutex_t fftw_mutex = PTHREAD_MUTEX_INITIALIZER;
static nrsc5_t *session;
static unsigned int audio_program;

unsigned int hd_audio_program(void)
{
    return audio_program;
}

int hd_set_program(unsigned int program)
{
    if (program >= MAX_PROGRAMS) return -1;
    audio_program = program;
    if (session)
    {
        for (unsigned int i = 0; i < MAX_PROGRAMS; i++)
        {
            if (i != program && session->output.aacdec[i])
            {
                NeAACDecClose(session->output.aacdec[i]);
                session->output.aacdec[i] = NULL;
            }
        }
    }
    return 0;
}

EM_JS(void, hd_numbers, (int type, int program, double a, double b), {
    Module.onNumbers(type, program, a, b);
});
EM_JS(void, hd_text, (int type, int program, const char *a, const char *b, const char *c, const char *d), {
    Module.onText(type, program, a ? UTF8ToString(a) : "", b ? UTF8ToString(b) : "", c ? UTF8ToString(c) : "", d ? UTF8ToString(d) : "");
});
EM_JS(void, hd_audio, (int program, const int16_t *data, int count, int flags), {
    Module.onAudio(program, HEAP16.subarray(data >> 1, (data >> 1) + count), flags);
});

static void callback(const nrsc5_event_t *event, void *opaque)
{
    (void) opaque;
    switch (event->event) {
    case NRSC5_EVENT_SYNC: hd_numbers(0, 0, event->sync.freq_offset, 0); break;
    case NRSC5_EVENT_LOST_SYNC: hd_numbers(1, 0, 0, 0); break;
    case NRSC5_EVENT_BER: hd_numbers(2, 0, event->ber.cber, 0); break;
    case NRSC5_EVENT_MER: hd_numbers(3, 0, event->mer.lower, event->mer.upper); break;
    case NRSC5_EVENT_AUDIO:
        hd_audio(event->audio.program, event->audio.data, event->audio.count, event->audio.flags); break;
    case NRSC5_EVENT_ID3:
        hd_text(0, event->id3.program, event->id3.title, event->id3.artist, event->id3.album, event->id3.genre); break;
    case NRSC5_EVENT_STATION_NAME: hd_text(1, 0, event->station_name.name, NULL, NULL, NULL); break;
    case NRSC5_EVENT_STATION_SLOGAN: hd_text(2, 0, event->station_slogan.slogan, NULL, NULL, NULL); break;
    case NRSC5_EVENT_STATION_MESSAGE: hd_text(3, 0, event->station_message.message, NULL, NULL, NULL); break;
    case NRSC5_EVENT_AUDIO_SERVICE_DESCRIPTOR:
        hd_numbers(4, event->asd.program, event->asd.type, event->asd.access); break;
    case NRSC5_EVENT_AUDIO_SERVICE:
        hd_numbers(4, event->audio_service.program, event->audio_service.type, event->audio_service.access); break;
    default: break;
    }
}

int hd_init(void)
{
    if (session) return -1;
    session = calloc(1, sizeof(*session));
    if (!session) return -1;
    audio_program = 0;
    session->mode = NRSC5_MODE_FM;
    session->callback = callback;
    output_init(&session->output, session);
    input_init(&session->input, session, &session->output);
    return 0;
}

int hd_process(const float *iq, unsigned int count)
{
    if (!session || count % 2) return -1;
    input_push_cf32(&session->input, iq, count);
    return 0;
}

void hd_destroy(void)
{
    if (!session) return;
    input_free(&session->input);
    output_free(&session->output);
    free(session);
    session = NULL;
}

void hd_reset(void)
{
    if (!session) return;
    input_reset(&session->input);
    output_reset(&session->output);
}
