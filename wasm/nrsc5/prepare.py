"""Adapt only native session plumbing; leave RF, FEC and codec implementations intact."""

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
