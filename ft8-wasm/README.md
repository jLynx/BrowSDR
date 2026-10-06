# Receive-only FT8 decoder

The committed `public/lib/ft8/decoder.js` and `.wasm` are built from the MIT-licensed
[kgoba/ft8_lib](https://github.com/kgoba/ft8_lib) revision recorded in `UPSTREAM`.
The required upstream sources and licenses are retained in `vendor/`.
No FT8 encoder or transmitter is compiled into the application.

Rebuild with Emscripten on PATH: `bash ft8-wasm/build.sh` (or `npm run build:ft8`).
Normal development/builds use the committed assets and need no compiler.

The adapter uses bounded result storage and callsign hash lookup, checks LDPC and
CRC, and reuses its audio allocation. It searches 200–3000 Hz. The displayed Sync
column is the library's synchronization score, **not an SNR measurement**.
DT is relative to FT8's nominal 0.5-second start within the UTC slot.

The test recording in `test/fixtures/ft8/` comes from the same upstream revision;
its `.txt` gives the independently recorded expected decode.
