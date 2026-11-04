# FM HD Radio decoder

BrowSDR uses a pinned nrsc5 receiver and its HDC-patched FAAD2 codec in a dedicated
WebAssembly module. FM HD Radio provides digital stereo audio, HD1–HD8 program
selection, station name/slogan/message, title/artist/album, digital lock, BER and
sideband MER. This initial implementation does not receive AM HD Radio or blend
between analog FM and digital audio. Album art and data services are not displayed.

Select **HD Radio** in a VFO and tune to the station's FM carrier. The receiver
must supply at least 744.188 kSPS, with the entire 400 kHz station inside its
received bandwidth. Use 1–2 MSPS or more when available. Acquisition and audio
buffering can take several seconds. Unmute the VFO to listen; muting retains the
decoder and station information. HD program numbers shown in the UI are one
higher than nrsc5's zero-based program index. A station may transmit only HD1.

The shared Rust DDC tunes and filters each VFO, resampling IQ to **744187.5 SPS**
exactly. nrsc5 receives normalized interleaved floats. Its 44.1 kHz stereo PCM is
resampled independently per channel to the app's 48 kHz mixer. Decoder work
stays in the VFO worker. A bounded PCM queue paces nrsc5's approximately 93 ms
audio bursts by IQ sample time, with 100 ms of initial buffering, so those
bursts do not overflow the shared playback buffer. Dropped input, tuning
changes and replay boundaries reset acquisition; lost lock does not play
analog audio. Valid digital audio
already in nrsc5's delayed buffer continues across RF lock loss, with native
silence for unavailable packets. Subchannel switching keeps RF lock while
clearing the previous program's PCM resampler history. Only the selected program
runs an HDC codec; switching releases the previous codec while retaining RF lock,
packet timing and metadata for every program.

## Rebuilding

Normal app builds use the committed `pkg/` files. To rebuild them:

```sh
npm run build:nrsc5
```

Requires Emscripten **4.0.7**, CMake, Python 3, tar, patch and Bash. Windows uses
the existing `~/emsdk` installation in WSL Ubuntu; set `NRSC5_WSL_DISTRO` to use
another distribution. On Linux/macOS, activate Emscripten before running the
command. `upstream.json` pins all source archives and their SHA-256 checksums.
Downloaded sources and compiler output remain ignored in `vendor/` and `build/`.
Use a fresh build directory after moving the checkout, since CMake caches
absolute paths.

`prepare.py` keeps upstream event reporting while replacing native device/session
plumbing with the synchronous FM IQ adapter in `wrapper.c`. It generates
`browser_output.c` to decode only the selected audio program and removes packet
buffers for enhanced streams that nrsc5 already ignores. All eight program
buffers and metadata remain available. The RF/FEC code and HDC codec
implementation are unchanged. The nrsc5 HDC patch is applied with
failure checking. No native USB/audio drivers or network/file inputs are linked.
Licenses and corresponding-source notices ship beside the JS/WASM assets.

The module reserves a 1 MiB stack with overflow checks. HDC parametric stereo
needs more than Emscripten's default 64 KiB stack, even before nested RF decoding.
Growing the WASM heap does not increase that stack. In the supplied 30-second
KSMG replay, WASM memory decreased from 49.4 MiB to 38.4 MiB after removing unused
buffers and limiting active codecs. This measures the decoder's linear memory,
not total browser RAM, and has not been tested on Chromebook hardware.

## Verification

```sh
npx vitest run --project client test/decoders/hd-radio
npm run test:nrsc5
npm run test:ui -- test/ui/decoders/hd-radio.spec.ts
npm run test:storybook
npm run check
```

The default tests cover loading the actual WASM decoder, silence without lock,
8/16-bit and float IQ through the production worker, lifecycle/late loads,
program switching, stereo PCM, gaps, muted channel plans, remote telemetry,
and the UI. Lifecycle tests simulate receiver rates; they are not hardware tests.
The Rust regression checks the exact fractional resampling ratio.

`build:nrsc5` also builds and runs `tests/memory.c` with the production stack
settings. `test:nrsc5` reruns that generated test module; rebuild first when C
sources or build flags change. It exercises the actual HDC parametric-stereo
codec, selection through all eight programs, ignored enhanced streams and codec
cleanup on switching/reset. It primes codec state and feeds synthetic silent HDC
frames; it is not an RF or live hardware test. The same test traps with a 64 KiB
stack.

To run the optional integration test against a signed-8-bit SigMF recording in
PowerShell (sample rate and centre frequency come from its matching metadata):

```powershell
$env:HD_RADIO_IQ = 'C:\path\FM Radio HD IQ Recording.sigmf-data'
npx vitest run --project client test/decoders/hd-radio/wasm.spec.js
```

Set `HD_RADIO_SECONDS` to limit the replay, `HD_RADIO_PROGRAM` to a zero-based
program index, and `HD_RADIO_OUTPUT` to a path stem to save decoded stereo WAV
and measurement JSON. The recording is kept outside the repository. Its optional
test is skipped when `HD_RADIO_IQ` is unset. In the development app, use **Add SDR
→ IQ File Replay**, select both SigMF files, choose HD Radio, and press Play.
