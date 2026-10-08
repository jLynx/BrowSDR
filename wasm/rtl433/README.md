# rtl_433 browser integration

BrowSDR builds the upstream C decoder library with Emscripten and a streaming
adapter. Each enabled VFO has its own decoder instance. The Rust DDC tunes and
filters IQ to 250 kS/s, 500 kS/s, or 1 MS/s; rtl_433 handles OOK/FSK detection and
protocol decoding. No native SDR driver, local service, or network output is used.
Decoding continues when VFO audio is muted. Remote VFOs decode on the host and
forward events/status over the existing command channel.

The generated `wasm/rtl433/pkg/rtl433.js`, `rtl433.wasm`, `COPYING`, and `NOTICE`
are committed. Normal builds require no C compiler. Keep source and notices
available with distributions of these GPL-2.0-or-later assets.

## Rebuild

Run `npm run build:rtl433` to rebuild the revision in `upstream.json` and run
the decoder tests. On Windows, this uses WSL Ubuntu and its existing
`~/emsdk` installation automatically (set `RTL433_WSL_DISTRO` for another
distribution). On Linux/macOS, activate Emscripten 4.0.7 in your shell first.
The build needs CMake, Python 3, curl, tar, and sha256sum. `upstream.json` pins
the immutable upstream commit, source archive SHA-256, and compiler version.
The downloaded source and compiler outputs are ignored. The only source change
reduces upstream scratch buffers to 65536 entries; the adapter feeds at most
32768 complex samples per call. Native hardware support is disabled; the adapter
does not link CLI teardown or initialize network/file outputs.

## Update upstream

```bash
npm run check:rtl433
npm run update:rtl433
# Or choose an upstream release tag or commit:
npm run update:rtl433 -- --ref 25.12
```

Checking only queries GitHub and does not require a compiler. Updating resolves
the chosen ref (default: `master`) to a commit, downloads and hashes its source,
rebuilds the WASM, regenerates `NOTICE`/`COPYING`, and runs the real decoder and
Rust DDC tests. Failed builds or tests restore the previous assets and pin.
Each revision has a separate CMake build directory to avoid stale source paths.
Already-current revisions are skipped; use `build:rtl433` to force a rebuild.

Before distributing an update, run `npm run typecheck`, `npm run build`, then
`npm run test -- --run`; optionally validate recorded OOK/FSK captures with the
command below. Review and commit `upstream.json` and all four
`wasm/rtl433/pkg` assets together. Upstream C API changes may require an
adapter change; new protocols are picked up automatically by a successful
build. Normal app builds keep using these tested assets. Updates are manual
and become available to users when the new app build is deployed.

## Reception

Enable **Decode rtl_433 sensors** on a VFO and tune it to the transmitter's
frequency (433.92 MHz is a common starting point). Decoder rate controls its
received IQ bandwidth independently of the audio bandwidth. Use 1 MS/s for
protocols requiring wider bandwidth; keep the whole decoder channel inside the
radio's sampled band. Blank protocol selection enables upstream defaults;
comma-separated IDs explicitly select protocols, including disabled defaults.
The searchable protocol list appears after a decoder loads. Events are bounded
to the latest 1000 entries and export as JSON Lines with time, VFO, frequency,
and the complete decoded payload. Unsupported signals do not produce events.

To validate the actual WASM decoder with a recorded `.cu8` capture, run:

```bash
node scripts/validate-rtl433.mjs capture.cu8 --rate 250000 --freq 433920000
```

Validation includes recorded Acurite OOK and AmbientWeather WH31 FSK captures,
with identical decoded payloads across large and small streaming blocks. Live
reception was also verified on a LimeSDR RX1/LNAL port at 61.44 MS/s: a muted
433.92 MHz VFO at 250 kS/s decoded CRC-validated Fineoffset-WHx080 weather
packets while the existing audio VFOs continued running. Automated tests feed
valid Waveman IQ through both the actual WASM decoder and the Rust DDC.
