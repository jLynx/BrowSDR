#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PIN="${1:-$ROOT/upstream.json}"
read -r COMMIT SHA256 EMSCRIPTEN < <(python3 - "$PIN" <<'PY'
import json, re, sys
pin = json.load(open(sys.argv[1]))
assert re.fullmatch(r'[0-9a-f]{40}', pin['commit']), 'Invalid upstream commit'
assert re.fullmatch(r'[0-9a-f]{64}', pin['sha256']), 'Invalid source checksum'
assert re.fullmatch(r'\d+\.\d+\.\d+', pin['emscripten']), 'Invalid compiler version'
print(pin['commit'], pin['sha256'], pin['emscripten'])
PY
)
SOURCE="$ROOT/rtl_433-$COMMIT"
BUILD="$ROOT/build/$COMMIT"
OUT="$ROOT/../public/lib/rtl433"
if [[ "$(emcc --version | head -1)" != *" $EMSCRIPTEN "* ]]; then
    echo "Activate Emscripten $EMSCRIPTEN before rebuilding rtl_433." >&2
    exit 1
fi
if [ ! -d "$SOURCE" ]; then
    if [ ! -f "$ROOT/source.tar.gz" ] || ! echo "$SHA256  $ROOT/source.tar.gz" | sha256sum --check --status; then
        curl -fL --retry 3 "https://codeload.github.com/merbanan/rtl_433/tar.gz/$COMMIT" -o "$ROOT/source.tar.gz"
    fi
    echo "$SHA256  $ROOT/source.tar.gz" | sha256sum --check
    tar xzf "$ROOT/source.tar.gz" -C "$ROOT"
fi
# Bound scratch memory to our streaming block size instead of the CLI's 4M samples.
# This is the only upstream source adaptation; protocol implementations are unchanged.
python3 - "$SOURCE/include/rtl_433.h" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
old = '#define MAXIMAL_BUF_LENGTH      (256 * 16384)'
new = '#define MAXIMAL_BUF_LENGTH      (65536)'
assert old in s or new in s, 'Unexpected rtl_433 buffer definition'
p.write_text(s.replace(old, new))
PY
emcmake cmake -S "$SOURCE" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_RTLSDR=OFF -DENABLE_SOAPYSDR=OFF -DENABLE_THREADS=OFF \
    -DENABLE_OPENSSL=OFF -DBUILD_TESTING=OFF -DBUILD_DOCUMENTATION=OFF \
    -DCMAKE_C_FLAGS=''
cmake --build "$BUILD" --target r_433 -j 4
emcc -O3 -DNDEBUG -I"$SOURCE/include" -I"$BUILD/include" \
    "$ROOT/wrapper.c" "$BUILD/src/libr_433.a" -lm \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=Rtl433Module \
    -s ENVIRONMENT=web,worker,node -s FILESYSTEM=0 -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=8388608 \
    -s EXPORTED_FUNCTIONS='["_rtl433_init","_rtl433_process","_rtl433_flush","_rtl433_destroy","_rtl433_protocol_count","_rtl433_protocol_name","_rtl433_protocol_disabled","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","stringToNewUTF8","HEAPF32"]' \
    -o "$BUILD/rtl433.js"
python3 - "$PIN" "$BUILD/NOTICE" <<'PY'
import json, pathlib, sys
pin = json.load(open(sys.argv[1]))
pathlib.Path(sys.argv[2]).write_text(f"""rtl_433 browser decoder for BrowSDR

Upstream: https://github.com/merbanan/rtl_433
Revision: {pin['commit']}
Source archive SHA-256: {pin['sha256']}
Compiler: Emscripten {pin['emscripten']}
License: GPL-2.0-or-later; see COPYING and upstream per-file copyright notices.

Corresponding source: upstream revision above, rtl433-wasm/wrapper.c and
rtl433-wasm/build.sh in the BrowSDR source repository. The build script reduces
MAXIMAL_BUF_LENGTH to 65536 for bounded browser streaming and disables native
SDR drivers. Network output and CLI teardown are excluded by the adapter and
linker; no file or socket input is opened. Device protocol code is unchanged.
""")
PY
mkdir -p "$OUT"
cp "$BUILD/rtl433.js" "$BUILD/rtl433.wasm" "$BUILD/NOTICE" "$OUT/"
cp "$SOURCE/COPYING" "$OUT/COPYING"
