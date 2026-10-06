#!/bin/bash
# Build mbelib as WASM module for BrowSDR DSD decoder.
#
# Prerequisites: Emscripten SDK 4.0.7 (emcc) must be in PATH.
#   Install: https://emscripten.org/docs/getting_started/downloads.html
#
# Usage: npm run build:mbelib (or bash mbelib-wasm/build.sh)
#
# Output: ../public/lib/mbelib/mbelib.js + mbelib.wasm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../public/lib/mbelib"
MBELIB_DIR="$SCRIPT_DIR/mbelib"
MBELIB_COMMIT="9a04ed5c78176a9965f3d43f7aa1b1f5330e771f"
MBELIB_SHA256="c7d6ebbbf3ca44bc10ee0755dede7f74fd65c31d1568d4174f29a68ae2f92278"
EMSCRIPTEN_VERSION="4.0.7"

if ! command -v emcc >/dev/null 2>&1; then
    echo "Emscripten $EMSCRIPTEN_VERSION is required. See mbelib-wasm/README.md." >&2
    exit 1
fi
COMPILER_VERSION="$(emcc --version)"
if [[ "${COMPILER_VERSION%%$'\n'*}" != *" $EMSCRIPTEN_VERSION "* ]]; then
    echo "Activate Emscripten $EMSCRIPTEN_VERSION before rebuilding. See mbelib-wasm/README.md." >&2
    exit 1
fi

for NOTICE_FILE in COPYRIGHT NOTICE; do
    if [ ! -f "$OUT_DIR/$NOTICE_FILE" ]; then
        echo "Restore public/lib/mbelib/$NOTICE_FILE before rebuilding." >&2
        exit 1
    fi
done

BUILD_DIR="$(mktemp -d)"
cleanup() {
    rm -f "$BUILD_DIR/source.tar.gz" "$BUILD_DIR/mbelib.js" "$BUILD_DIR/mbelib.wasm"
    rmdir "$BUILD_DIR"
}
trap cleanup EXIT

# Download pinned upstream source only for an explicit codec rebuild.
if [ ! -d "$MBELIB_DIR" ]; then
    echo "Downloading mbelib source..."
    curl -fL --retry 3 "https://codeload.github.com/szechyjs/mbelib/tar.gz/$MBELIB_COMMIT" -o "$BUILD_DIR/source.tar.gz"
    if command -v sha256sum >/dev/null 2>&1; then
        ARCHIVE_HASH="$(sha256sum "$BUILD_DIR/source.tar.gz")"
    else
        ARCHIVE_HASH="$(shasum -a 256 "$BUILD_DIR/source.tar.gz")"
    fi
    if [ "${ARCHIVE_HASH%% *}" != "$MBELIB_SHA256" ]; then
        echo "mbelib archive checksum mismatch; source was not extracted." >&2
        exit 1
    fi
    tar xzf "$BUILD_DIR/source.tar.gz" -C "$SCRIPT_DIR"
    mv "$SCRIPT_DIR/mbelib-$MBELIB_COMMIT" "$MBELIB_DIR"
    echo "mbelib source downloaded."
fi

echo "Building mbelib WASM..."
emcc -O3 \
    -s WASM=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='MbelibModule' \
    -s EXPORTED_FUNCTIONS='["_mbelib_init","_mbelib_reset","_mbelib_decode_ambe","_mbelib_decode_imbe","_mbelib_get_err_str","_mbelib_get_errs","_mbelib_get_errs2","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","UTF8ToString","HEAPF32","HEAP8"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=1048576 \
    -s ENVIRONMENT='web,worker' \
    -s FILESYSTEM=0 \
    -s ASSERTIONS=0 \
    -I"$MBELIB_DIR" \
    -o "$BUILD_DIR/mbelib.js" \
    "$SCRIPT_DIR/wrapper.c" \
    "$MBELIB_DIR/ambe3600x2400.c" \
    "$MBELIB_DIR/ambe3600x2450.c" \
    "$MBELIB_DIR/ecc.c" \
    "$MBELIB_DIR/imbe7100x4400.c" \
    "$MBELIB_DIR/imbe7200x4400.c" \
    "$MBELIB_DIR/mbelib.c"

# Preserve the working deployment files if download or compilation fails.
cp "$BUILD_DIR/mbelib.js" "$BUILD_DIR/mbelib.wasm" "$OUT_DIR/"
cp "$MBELIB_DIR/COPYRIGHT" "$OUT_DIR/COPYRIGHT"

echo "Build complete: $OUT_DIR/mbelib.js + mbelib.wasm"
echo "File sizes:"
ls -lh "$OUT_DIR"/mbelib.*
