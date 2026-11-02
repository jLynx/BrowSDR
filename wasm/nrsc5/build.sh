#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [[ "$(emcc --version | head -1)" != *" 4.0.7 "* ]]; then
    echo "Activate Emscripten 4.0.7 before rebuilding HD Radio." >&2
    exit 1
fi
cd "$ROOT/vendor/faad2"
if ! grep -q 'NeAACDecInitHDC' include/neaacdec.h; then
    patch -p1 < ../nrsc5/support/faad2-hdc-support.patch
fi
python3 "$ROOT/prepare.py"
emcmake cmake -S "$ROOT" -B "$ROOT/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$ROOT/build" --target hd_decoder fftw3f faad_hdc -j 4
mkdir -p "$ROOT/pkg"
emcc -O3 "$ROOT/build/libhd_decoder.a" "$ROOT/build/faad2/libfaad_hdc.a" "$ROOT/build/fftw/libfftw3f.a" -lm \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=Nrsc5Module \
    -s ENVIRONMENT=web,worker,node -s FILESYSTEM=0 -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=33554432 \
    -s EXPORTED_FUNCTIONS='["_hd_init","_hd_process","_hd_reset","_hd_destroy","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAPF32"]' -o "$ROOT/pkg/nrsc5.js"
cp "$ROOT/vendor/nrsc5/LICENSE" "$ROOT/pkg/LICENSE-nrsc5"
cp "$ROOT/vendor/faad2/COPYING" "$ROOT/pkg/COPYING-faad2"
cp "$ROOT/vendor/fftw/COPYING" "$ROOT/pkg/COPYING-fftw"
cp "$ROOT/NOTICE" "$ROOT/pkg/NOTICE"
cp "$ROOT/COPYING.GPL3" "$ROOT/pkg/COPYING.GPL3"
