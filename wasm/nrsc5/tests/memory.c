#include "common.h"
#include "structs.h"
#include "sbr_dec.h"
#include "../wrapper.c"

/* Prime the state reached after receiving a mono HDC program with parametric
 * stereo. Silent HDC frames exercise its real decode/upsampling path, including
 * the fallback before the next SBR header arrives. This is a codec test, not RF. */
static void prime_ps(unsigned int program)
{
    NeAACDecHandle *handle = &session->output.aacdec[program];
    NeAACDecInitHDC(handle);
    NeAACDecStruct *decoder = *handle;
    decoder->sbr[0] = sbrDecodeInit(1024, 0, 44100, 0, 0);
    decoder->sbr[0]->Is_HDC_SBR = 1;
    decoder->sbr[0]->ps_used = 1;
    decoder->ps_used[0] = 1;
    decoder->ps_used_global = 1;
}

int hd_test_memory(void)
{
    if (hd_init() != 0) return 1;
    uint8_t silence[8] = {0};
    for (unsigned int cycle = 0; cycle < 2; cycle++)
    {
        for (unsigned int program = 0; program < MAX_PROGRAMS; program++)
        {
            if (hd_set_program(program) != 0) return 2;
            for (unsigned int i = 0; i < MAX_PROGRAMS; i++)
                if (i != program && session->output.aacdec[i]) return 3;
            prime_ps(program);
            for (unsigned int frame = 0; frame < 4; frame++)
            {
                for (unsigned int i = 0; i < MAX_PROGRAMS; i++)
                {
                    output_align(&session->output, i, 0, 0);
                    for (unsigned int seq = 0; seq < 2; seq++)
                    {
                        packet_ref_t packet = {
                            .data = silence, .size = sizeof(silence), .program = i,
                            .stream_id = 0, .seq = seq, .shape = PACKET_FULL,
                        };
                        output_push(&session->output, &packet);
                        // Enhanced streams remain ignored without allocated buffers.
                        packet.stream_id = 1;
                        output_align(&session->output, i, 1, 0);
                        output_push(&session->output, &packet);
                    }
                }
                output_advance(&session->output);
                if (!session->output.aacdec[program]) return 4;
                for (unsigned int i = 0; i < MAX_PROGRAMS; i++)
                    if (i != program && session->output.aacdec[i]) return 5;
            }
        }
        hd_reset();
        for (unsigned int i = 0; i < MAX_PROGRAMS; i++)
            if (session->output.aacdec[i]) return 6;
    }
    if (hd_set_program(MAX_PROGRAMS) != -1) return 7;
    hd_destroy();
    return 0;
}
