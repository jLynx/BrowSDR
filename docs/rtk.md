# Live RTK base stations

BrowSDR decodes RTK IQ continuously in its browser VFO workers, using the same
streaming path as the other packet decoders. The SDR supplies IQ; TypeScript
handles LoRa acquisition, coding, station identification and RTCM reassembly.
Live reception needs no companion script, service or GNU Radio installation.
The station browser is general RTK UI. Radio decoding currently supports the
verified Mammotion LoRa wrapper and an experimental LoRa profile; other RTK
radio protocols still need their own decoders.

## Measured signals

These profiles were verified with LimeSDR-USB, RX1_L (RX1 / LNAL).

| Signal | Measured centre           | PHY                                                                                         | Identity                                                            |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Upper  | approximately 923.118 MHz | SF7, BW500 kHz, CR4/6, explicit header, payload CRC, preamble32, sync [40,36], LDRO enabled | Mammotion wrapper and RTCM verified; receiver UNICORE UM960         |
| Lower  | approximately 915.190 MHz | SF7, BW250 kHz, CR4/5, explicit header, no payload CRC, preamble16, sync [16,8]             | **Unverified**; Luba 2 pairing and payload format remain unresolved |

These are uncalibrated receiver measurements. The antenna label does not
establish an exact frequency. A Mammotion pairing code describes
scan/channel/loc/net fields; its first number is not a frequency. The lower
signal's pairing fields have not been identified.
The bases are not interchangeable, and the Luba 1 wrapper is not assumed to
apply to Luba 2.

## Live browser workflow

1. Start BrowSDR with `npm run dev` and open <http://localhost:5173/>.
2. Connect LimeSDR, select RX1 and LNAL, and choose 1 MSPS or higher.
3. Open **Tools → RTK**, choose a VFO, and enable **Decode**. Audio can remain
   muted and decoding continues when the panel is closed.
4. The list combines verified bases from all enabled RTK VFOs. Select a row
   to see that base's location and map, satellite counts, GNSS signal quality
   and receiver model. **Decoder settings** controls the selected VFO's profile
   and preset tuning.
5. **Save data** offers a station summary (JSON) or a verified correction
   stream (RTCM3), with explanations of both formats. **Diagnostics** contains
   pairing fields, message types, satellite IDs and packet/error counters.

The panel shows a **LoRa number** derived from received packet headers. The
supported wrapper exposes scan, channel and net ID, but the loc field remains
unresolved. For the invented test station it displays `1234.7.?.42` with
**loc unknown**. The decoder does not require a pairing number as input or use
it as a decryption key. A supplied number can help associate an already-decoded
signal with a particular base; it does not enable unsupported payload formats.

Each VFO retains the latest 512 RTCM messages automatically. Retuning clears
that VFO's saved corrections when the new stream arrives; restarting reception
clears all saved results.

### Multiple bases

A VFO can track up to 16 distinct scan/channel/net identities on the same
frequency, with independent RTCM fragment buffers. Successfully received
alternating packets are reassembled per base. Simultaneous RF transmissions
can collide; the receiver does not separate overlapping LoRa waveforms or
distinguish bases that share all currently decoded identity fields.

The list combines enabled VFOs and hides stale-frequency results after a
retune. Multiple VFOs receiving the same identity, frequency and profile share
one row with all VFO numbers. Disabling or removing a VFO removes its entries.
Row selection stays stable during packet updates and activates the associated
VFO without retuning it or changing decoder/audio settings. The map and GNSS
details show the selected base. Correction exports contain only that base's
frames from the selected VFO, even if RTCM station IDs are reused. Export
filenames include the decoded identity. Radio diagnostics remain VFO-wide.

The centre can differ from the VFO frequency: the existing WASM DDC supplies
a 1 MSPS channel to the LoRa receiver. For a 10 MSPS view covering both
signals, use a centre near 919 MHz and separate VFOs at 923.118 and 915.190 MHz.
Select the lower profile on the second VFO. Its valid-header counter is
diagnostic; unchecked payloads never become verified station or RTCM results.
RTK telemetry currently works with a locally connected SDR, not remote
WebRTC clients.

**Decoder settings** includes a sample timing adjustment in ppm. The measured
500 kHz signal uses +20 ppm; the lower profile starts at 0. This compensates
sample timing, not carrier frequency calibration. Another SDR may need a
different value.

## Validation and format

Fresh live RF produced CRC-verified Luba 1 packets and valid RTCM types
1006, 1033, 1074 (GPS), 1084 (GLONASS), 1094 (Galileo) and 1124 (BeiDou).
The panel decodes 1005/1006 antenna-reference ECEF coordinates into latitude,
longitude and ellipsoid height, 1033 receiver/antenna descriptors, and MSM4–7
satellite/signal masks and C/N₀. Counts describe satellites included in recent
correction packets, rather than satellites used by a rover's position solution.
The reported ECEF position is converted on the WGS84 ellipsoid without an
ITRF epoch/datum transformation; ellipsoid height is not height above sea level.
RTK fixed/float status is a rover-solution field and is not present in these
base correction messages.

The station title comes from the RTCM 1033 receiver descriptor, currently
**UNICORE UM960**. Other receivers and pairing IDs using the verified wrapper
can be decoded too; the decoder does not restrict packets to the user's pairing.
The internal profile key `luba1` remains for compatibility with saved settings;
its display name is **Mammotion LoRa · 500 kHz**. Receiver model alone does not
define the radio protocol, so this is not a universal UM960 radio decoder.

### Satellite bands and quality

L1 and L2 are GNSS frequency bands. Mammotion displays L1/L2 counts in its
positioning information; a satellite may contribute to both counts.
BrowSDR shows **L1 / primary** (GPS L1, GLONASS G1, Galileo E1, BeiDou B1) and
**L2 / secondary** (GPS L2, GLONASS G2, Galileo E5b, BeiDou B2). Counts use
active MSM satellite/signal cells, deduplicated within each frequency group.
Other bands, including L5, E5a and B3, appear in Diagnostics. Unknown signal IDs
are not assigned a band. These are correction-stream counts; Mammotion's
receiver filtering and its rover/co-viewing counts can differ.

**GNSS signal** shows the mean positive C/N₀ of recent satellite measurements.
The indicative labels are Good at ≥40 dB-Hz, Fair at ≥30 dB-Hz, and Weak below
30 dB-Hz. Zero C/N₀ means unavailable and is excluded from that mean, but an
active cell can still contribute to band counts. Observations expire after
five seconds or when decoding/reception stops. This rating is separate from
LoRa RSSI/SNR (not currently measured) and from positioning fix status.
**Live corrections** requires a recent RTCM CRC-verified message, not just a
radio packet. GNSS signal quality is not a fixed/float solution status.

The map marks the decoded base coordinates using the existing Leaflet and
OpenStreetMap tile pattern. Internet access is needed for tiles; coordinates
remain readable if tiles fail. The map preserves pan/zoom as corrections arrive
and recentres when switching to another base. It shows the base reference location.

The test waveform is generated entirely in JavaScript from invented pairing
fields and an RTCM reference at 0° latitude, 0° longitude. Tests exercise
streaming across irregular chunk boundaries, clock drift and lost IQ chunks
without transmitting RF or depending on local captures.

The verified Luba 1 wrapper is:

```text
2C CHANNEL CHECKSUM? CHECKSUM? NET_ID SCAN_HI SCAN_LO BODY_LENGTH <body>
```

The two labelled checksum bytes and the loc field remain uninterpreted.
Bodies use XOR `0x12`; RTCM frames can span radio packets. Both LoRa payload CRC and
RTCM CRC24Q must pass. Invalid packets and lost IQ chunks clear incomplete
buffers; alternating station identities retain separate buffers. RTCM reference-station IDs differ from Mammotion pairing
IDs. The lower PHY has no payload CRC, so its payload remains untrusted;
this does not establish encryption.

The implementation uses bounded IQ history, throttled UI messages and
existing worker backpressure. Retunes, profile changes, sample-rate changes
and sequence gaps reset acquisition. No new application dependency is needed.

## Capture files and fixtures

**Tools → IQ Capture** records raw signed IQ with SigMF metadata for further
protocol research. Capture buffers are copied before USB reuse and cancelled
on receiver lifecycle/configuration changes. Download both data and metadata.

RF captures, station exports and screenshots may expose a base's precise
coordinates or pairing identifiers. They are ignored under `output/rtk/` and
must not be used as public fixtures. The test fixture contains only invented
identifiers and mock coordinates. Tests require no private files.
The Storybook **Receiver / RTK Base Stations / Multiple Bases** example uses
only invented identities and coordinates for visual review without hardware.

## References

- [gr-lora_sdr](https://github.com/tapparelj/gr-lora_sdr): PHY reference and independent synthetic waveform generator. Browser decoding uses its own TypeScript implementation.
- [VE2MRX Mammotion RTK research](https://github.com/Ve2mrx/mammotion-rtk-lora): related RTK3 research; its wrapper and hopping assumptions differ from this verified Luba 1 signal.
- [PyMammotion](https://github.com/mikey0000/PyMammotion): scan/channel/loc/net pairing fields.
- [Mammotion positioning information](https://support.mammotion.com/portal/en/kb/articles/about-the-new-positioning-information-and-how-to-troubleshoot-the-related-issues): L1/L2 counts, reference/robot/co-viewing satellites, GNSS quality and positioning status.
- [RTKLIB MSM signal tables](https://github.com/rtklibexplorer/RTKLIB/blob/demo5/src/rtcm3.c): RTCM signal IDs and GNSS frequency bands. Reserved and tentative extension IDs remain unmapped.
