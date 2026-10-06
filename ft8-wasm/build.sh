#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
emcc -O3 -Ivendor decoder.c vendor/common/monitor.c vendor/fft/kiss_fft.c vendor/fft/kiss_fftr.c \
  vendor/ft8/{decode,constants,crc,ldpc,message,text}.c \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node \
  -s FILESYSTEM=0 -s ALLOW_MEMORY_GROWTH=1 -s STACK_SIZE=262144 \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8"]' \
  -s EXPORTED_FUNCTIONS='["_ft8_init","_ft8_decode","_ft8_results","_ft8_reset","_malloc","_free"]' \
  -o ../public/lib/ft8/decoder.js
