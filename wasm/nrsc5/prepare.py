"""Adapt session/audio plumbing; leave RF, FEC and codec implementations intact."""

from pathlib import Path

root = Path(__file__).resolve().parent
source = root / 'vendor/nrsc5/src'
original = (source / 'nrsc5.c').read_text()
names = original[original.index('void nrsc5_service_data_type_name'):original.index('static nrsc5_t *nrsc5_alloc')]
events = original[original.index('void nrsc5_report(nrsc5_t'):]
(source / 'browser_events.c').write_text('#include <assert.h>\n#include <string.h>\n#include "private.h"\n' + names + events)
private = (source / 'private.h').read_text().replace('#include <rtl-sdr.h>', 'typedef struct rtlsdr_dev rtlsdr_dev_t;')
(source / 'private.h').write_text(private)
(source / 'config.h').write_text('#pragma once\n#define HAVE_STRNDUP 1\n#define USE_FAAD2 1\n#define LIBRARY_DEBUG_LEVEL 5\n#define CMPLXF(x,y) __builtin_complex((float)(x), (float)(y))\n')

# nrsc5 does not decode enhanced streams (stream_id != 0). Avoid reserving
# another 9 MB of packet buffers for those streams, while retaining all programs.
header = source / 'output.h'
header_text = header.read_text()
if 'elastic[MAX_PROGRAMS][MAX_STREAMS]' not in header_text and 'elastic[MAX_PROGRAMS][1]' not in header_text:
    raise RuntimeError('Unexpected nrsc5 elastic buffer declaration')
header.write_text(header_text.replace('elastic[MAX_PROGRAMS][MAX_STREAMS]', 'elastic[MAX_PROGRAMS][1]'))

# Keep packet timing and metadata for every program, but run only the selected
# HDC codec. Unselected codecs follow nrsc5's existing close/reset path.
output = (source / 'output.c').read_text()
replacements = [
    ('void output_align(output_t *st, unsigned int program, unsigned int stream_id, unsigned int offset)\n{',
     'extern unsigned int hd_audio_program(void);\n\nvoid output_align(output_t *st, unsigned int program, unsigned int stream_id, unsigned int offset)\n{\n    if (stream_id != 0) return;'),
    ('void output_push(output_t *st, const packet_ref_t* ref)\n{',
     'void output_push(output_t *st, const packet_ref_t* ref)\n{\n    if (ref->stream_id != 0) return;'),
    ('if (is_complete_pkt(pkt) && is_crc_ok(pkt))',
     'if (program == hd_audio_program() && is_complete_pkt(pkt) && is_crc_ok(pkt))'),
    ('if (!produced_audio)', 'if (!produced_audio && program == hd_audio_program())'),
    ('j < MAX_STREAMS', 'j < 1'),
]
for before, after in replacements:
    if output.count(before) != 1:
        raise RuntimeError(f'Unexpected nrsc5 output source: {before}')
    output = output.replace(before, after)
(source / 'browser_output.c').write_text(output)
