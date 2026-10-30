# IQ file replay

Choose **Add SDR → IQ File Replay**. Select one `.sigmf-data` file and its matching
`.sigmf-meta` or `.sigmf-meta.json` file together, then **Load recording**. This
is available during local development (`npm run dev`), alongside Mock SDR, and
requires no USB device. It is hidden and disabled in production. The receiver starts paused so
you can configure VFOs and decoders before pressing **Play replay**.

Replay reads the file locally in chunks of at most 256 KiB and delivers its signed
8-bit complex samples through the same `startRxStream`, spectrum, channelization,
audio and decoder path used by local hardware. A multi-gigabyte file does not need
to fit in browser memory. File contents are not uploaded. Playback targets 1×
sample time; disk/browser stalls stretch playback instead of producing an
unbounded catch-up burst. Any downstream DSP drops still appear in receiver
diagnostics and invalidate decoder continuity as they do with hardware.

The Source panel shows playback position and provides **Pause replay** and
**Restart**. Pause preserves the file position; restarting returns to the beginning.
Reception restarts create fresh decoder acquisition and discard incomplete
fragments. At end of file, queued DSP deliveries finish before reception stops;
press Play again to replay from the beginning. Disconnect releases the recording
and restores the previous radio/VFO/gain/view settings. Replay changes do not
overwrite saved hardware settings.

Use **Change recording** in the Source panel to replace the file in the same
receiver. Select the replacement data and matching metadata, then **Replace
recording**. Cancel keeps the current file and playback unchanged. Loading a valid
replacement stops playback, clears results from the old recording and starts the
new file paused at sample zero. Your VFO frequencies and decoder settings remain;
VFOs outside the new recording's bandwidth need retuning. Disconnect still restores
the hardware settings from before the first file was loaded.

The centre frequency, sample rate and display frequency shift are fixed by the
recording. VFOs can tune within the recorded bandwidth. Changing gain, selecting
a different sample rate, or tuning outside that bandwidth cannot recreate RF
that was not captured. The waterfall retains normal zoom and display controls.

## Supported files

Replay currently supports uncompressed SigMF `ci8`: signed 8-bit I first, Q second,
one capture beginning at sample zero, without file offsets or trailing bytes.
Sample rates from 1 kSPS to 61.44 MSPS are accepted. The loader rejects unsupported
formats, multiple tuning segments, incomplete sample pairs and mismatched file
names. If metadata is unavailable, select a `.sigmf-data` or `.iq` file and enter
its original sample rate, SDR centre and display frequency shift manually.

Capture continuity is reported from BrowSDR metadata where available. An unknown
missing-sample count remains unknown; replay cannot reconstruct samples omitted
from the original recording.

## RTK recordings

For the supplied 20 MSPS recordings, metadata restores the receiver centre to
923.118 MHz. Configure separate VFOs before pressing Play:

| Stream                   | Profile | Initial VFO | Sample timing | Following             |
| ------------------------ | ------- | ----------- | ------------- | --------------------- |
| RTK1 in these recordings | RTK1    | 919.058 MHz | +20 ppm       | Off                   |
| Compact RTK2-compatible  | RTK2    | 921.791 MHz | +10 ppm       | Recorded NZ RTK2 hops |
| RTK3                     | RTK3    | 915.401 MHz | 0 ppm         | Recorded NZ RTK3 hops |

See [RTK reception and measured channel plans](rtk.md). Configure only the streams
you need to test; each enabled VFO adds DSP work. Audio may stay muted.

## What a replay test establishes

Real recorded IQ exercises acquisition, protocol parsing, frequency-hop following,
spectrum/display and audio scheduling with real RF noise and interference. A 1×
browser replay is a repeatable integration/performance test of those paths.
It does not test current WebUSB transfers, hardware tuning/gain commands,
oscillator behaviour, or present RF conditions. Original capture losses remain
in the data, while disk/browser scheduling can introduce different delivery
jitter from USB. Treat replay and fresh hardware reception as complementary tests.
