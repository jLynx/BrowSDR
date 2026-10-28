# Live RTK base stations

BrowSDR decodes RTK IQ continuously in its browser VFO workers, using the same
streaming path as the other packet decoders. The SDR supplies IQ; TypeScript
handles LoRa acquisition, coding, station identification and RTCM reassembly.
Live reception needs no companion script, service or GNU Radio installation.
The station browser is general RTK UI. Radio decoding currently supports the
verified Mammotion RTK1 and RTK2 wrappers, an experimental RTK3 / RBS03 decoder,
and an unidentified experimental LoRa profile. Other RTK radio protocols still need
their own decoders.

## RTK2 / DU1021D support

Select **Decoder settings → Mammotion RTK2 · 250 kHz**, then use
**Tune to 915.191 MHz** for the frequency measured on the tested receiver. The
base can select another channel during startup; if the preset is quiet, tune
to its active signal in the waterfall. This decoder
was validated against a recorded RTK2 power cycle: 619 complete recovered radio
packets passed CRC8/MAXIM and container CRC16/MODBUS, yielding 270 RTCM frames
with valid CRC24Q. Independent gr-lora_sdr replay also matched 96 complete radio
payloads, including 38 maximum-length packets. Live validation in the built-in
browser with LimeSDR-USB on 28 October 2026 also recovered 479 verified radio
packets and 376 CRC24Q-valid RTCM corrections at approximately 915.191 MHz,
with RTK1 decoding simultaneously. Live reception rejected 17 application
frames and one RTCM frame; lost IQ chunks remained zero. The base reported
UNICORE and GPS, GLONASS, Galileo and BeiDou observations.

The PHY is SF7, BW250 kHz, CR4/5, explicit header, preamble16, no LoRa payload
CRC, LDRO off and sync **[16,8]**. Timing starts at +10 ppm for the measured
receiver. Tune to the active signal in the waterfall: the recording shows
startup channel changes between approximately 915.191 and 924.116 MHz, without
establishing continuous hopping or a universal regional channel plan. Automatic
channel following is not available.

DU1021D applies a reversible bit transpose, nibble substitution, parity mixing
and fixed mask after application framing. The decoder undoes that transform
after standard LoRa dewhitening. The resulting outer frame is:

```text
5D A6 NETWORK[8] ADDRESS_LE16 BODY_LENGTH_LE16 RADIO_SEQUENCE_U8
<body> CRC8/MAXIM 0D 0A
```

The body is one container:

```text
A5 5A 04 01 04 01 LENGTH_LE16 SEQUENCE_LE16
<correction stream chunk> CRC16/MODBUS_LE16
```

Both checksums include their respective headers and exclude checksum trailers.
Zero-length containers are keepalives; they contain no RTCM. Nonempty containers
carry arbitrary chunks of the RTCM byte stream, so one RTCM frame can span
several containers and one container can include several RTCM frame boundaries.
Each reconstructed RTCM frame must pass CRC24Q before appearing in the station
map, satellite observations or correction exports.

Reassembly is isolated by the raw eight-byte network field and 16-bit address,
bounded to 16 bases and a maximum RTCM frame per partial stream. Duplicate
container sequences are suppressed. Gaps, counter restarts, corrupt packets,
IQ discontinuities, retunes, profile changes and more than two seconds of
silence discard incomplete corrections. Keepalives preserve adjacent fragments.
The UI displays the validated address; the complete pairing-number mapping
has not been established. No pairing number is required as a decoding key.

The recorded base reports **UNICORE** in RTCM1033, without a receiver model or
firmware descriptor. This does not establish whether that base uses UM960.
RTCM1006, 1033, 1074, 1084, 1094 and 1124 were recovered, covering reference
position, equipment and GPS/GLONASS/Galileo/BeiDou MSM4 observations.

## Experimental RTK3 / RBS03 support

Select **Decoder settings → Mammotion RTK3 · 250 kHz (experimental)**
to decode the format documented by
[Martin Boissonneault (VE2MRX)](https://github.com/Ve2mrx/mammotion-rtk-lora/blob/7cb61c36187c4becd408a99be4f0050d416e65bf/PROTOCOL.md)
from an RBS03 base with a Luba mini in the US. This implementation was checked
with invented packets and synthetic IQ, **without RTK3 hardware or real RTK3
captures**. Firmware and regional variations remain unverified.

The profile uses LoRa SF7, BW250 kHz, CR4/5, explicit header, preamble16,
no LoRa payload CRC and LDRO off. Standard private sync word **0x12** maps to
SF7 sync symbols **[8,16]**; this differs from RTK2's
observed **[16,8]**. The profiles remain separate. Timing starts at 0 ppm because
no RTK3/SDR clock error has been measured; adjust it for your receiver.

Tune the VFO to an active channel in the waterfall within the received band
(currently 900–930 MHz, at 1 MSPS or higher). There is no guessed frequency
preset or automatic hop follower. VE2MRX reports 25 ascending US slots spaced
1 MHz apart, 600 ms per slot and a 15-second lap, with the lowest slot silent.
A fixed VFO can decode intermittent bursts during visits to its channel; it
will miss most of that hopping stream and may not receive all base details.
The reported US plan is not assumed to apply to New Zealand or other regions.

Every accepted radio frame must have the documented `00 00` prefix, a
little-endian 16-bit address, length no greater than 231 bytes, and valid
**CRC16/MODBUS** over the full frame including its address. Frames with detected
coding parity errors are rejected. Complete 21-byte beacons with marker
`55 55 00 40`, five padding zeros and `AA AA` are counted separately; neither
beacons nor the address and CRC trailers enter the container stream.

Data containers use:

```text
A5 5A 04 01 04 TYPE LENGTH_LE16 SEQUENCE_LE16 <payload>
```

Type `01` must contain exactly one complete RTCM3 frame, including its matching
length and valid **CRC24Q**. Type `00` is consumed without interpreting or
exporting its contents. Containers may span radio frames and interleaved beacons.
Reassembly is isolated by address and bounded to 16 bases. Invalid radio frames,
lost IQ chunks, retunes, profile/rate changes and more than two seconds of silence
discard incomplete containers. A decreasing beacon uptime also clears that
base's partial stream and sequence state. Repeated container sequence numbers
are suppressed; forward increments, including 16-bit wrap, provide gap
diagnostics. These increments do not directly measure lost radio frames or USB
samples.

Checksum-verified corrections feed the existing station list, position/map,
GNSS observations and per-base RTCM exports. The UI shows only the decoded
**LoRa station address**, without inventing scan/channel/loc values. Beacons
alone show **Verified beacons** and never create a correction station row or map.
Radio rejection and invalid RTCM-container counters remain separate.

RTK2 uses its own transformed outer wrapper and CRC8, rather than the RTK3
address-and-CRC16 radio wrapper. The profiles remain separate.

## Measured signals

These profiles were verified with LimeSDR-USB, RX1_L (RX1 / LNAL).

| Signal | Measured centre                                                                                        | PHY                                                                                         | Identity                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Upper  | approximately 923.118 MHz                                                                              | SF7, BW500 kHz, CR4/6, explicit header, payload CRC, preamble32, sync [40,36], LDRO enabled | Mammotion wrapper and RTCM verified; receiver UNICORE UM960                 |
| RTK2   | approximately 915.191 MHz; startup at 924.116 MHz in the long recording, 918.060 MHz in earlier slices | SF7, BW250 kHz, CR4/5, explicit header, no payload CRC, preamble16, sync [16,8]             | DU1021D wrapper and RTCM verified; receiver reports UNICORE without a model |

These are uncalibrated receiver measurements. The antenna label does not
establish an exact frequency. A Mammotion pairing code describes
scan/channel/loc/net fields; its first number is not a frequency. The experimental
signal's full pairing-field mapping has not been identified.
The bases are not interchangeable, and the Luba 1 wrapper is not assumed to
apply to Luba 2.

### FCC and New Zealand frequency references

FCC ID **2A8QJ-RTK0002** identifies the Luba 2 AWD RTK Reference Station.
Its January 2024 LoRa test report, SGS **SZCR231000347702** (exhibit 7089749),
lists CSS modulation and 26 US channels on page 6:

| Channels | Centre frequencies (MHz)                            |
| -------- | --------------------------------------------------- |
| 0        | 902.500                                             |
| 1–10     | 903.125–912.125, in 1 MHz steps                     |
| 11–23    | 914.125–926.125, in 1 MHz steps; 913.125 is omitted |
| 24–25    | 926.500, 926.800                                    |

Channel 12 is 915.125 MHz and channel 20 is 923.125 MHz. Page 52 reports
measured 6 dB bandwidths of 621, 624 and 616 kHz at the low, middle and high
test frequencies. These are occupied-bandwidth measurements, not proof of
a 625 kHz LoRa modem setting. The report does not establish the spreading
factor, coding rate, sync word or application payload format.

The installation being investigated is in New Zealand. The local SRD licence
lists the **915–928 MHz** band; this is a search-band reference, not a
Mammotion-specific channel plan. The FCC's wider US table does not establish
the active frequency or regional configuration of a New Zealand/Australian
base. Antenna labels and pairing numbers do not settle that question either.

A July 2024 community report describes changed Luba 2 firmware using frequency
hopping in the European band. It is an investigative lead, not confirmation
of hopping or a channel plan for this installation. Short captures on one
frequency cannot exclude an intermittent or hopping transmitter.

### Waterfall candidates and receiver images

Live waterfall inspection also found weak, narrow bursts around 918.8–919.55 MHz.
The discovery tool estimated widths around 1–3 kHz for several bursts. The user
subsequently switched off both RTK bases together: the regular wider streams
disappeared, but the small dots continued. Exclude those dots from the RTK
investigation; their modulation and source have not been identified.

A 32-second narrow-band capture also contained interference at frequencies
consistent with the two stronger streams aliasing into the reduced sample
span. Individual FFT peaks from that recording must not be interpreted as
separate hopping transmissions.

A stronger apparent third stream near 931.06 MHz moved to approximately
928.815 MHz when the SDR centre changed from 923.125 to 922 MHz, while the
915.19 MHz stream stayed at its frequency. This matches an IQ receiver image
at `2 × centre − signal`, with matching burst timing. Receiver images can also
appear for the verified 923 MHz stream. Check how a candidate responds to
centre retuning before treating every waterfall trace as a separate transmitter.

### Reported power-cycle sequence

The user's screenshots and account of restarting both bases together show:

1. Paired side streams initially appear closer to the receiver centre.
2. The verified 923.118 MHz correction stream starts.
3. The initial side streams stop, and the wider-spaced 915.19 MHz stream and
   its approximately 931.06 MHz receiver image appear.

This strengthens the association between the 915.19 MHz stream and the powered
RTK equipment. With the 923.118 MHz stream already associated with Luba 1,
915.19 MHz is the leading Luba 2 candidate. The two side traces represent a
signal and its receiver image, not two independently identified transmitters.
The initial change may be channel selection during startup; continuous hopping
has not been established. Both bases were switched together, so the test does
not independently assign the second stream to one base or verify its payload.

### Recorded power-cycle results

The following short-slice experiments are historical. Their application bytes
were subsequently resolved by the RTK2 decoder described above; the long
recording provides the current checksum and RTCM validation.

A subsequent restart of both bases was recorded in fourteen short IQ slices
at 10 MSPS, centred at 919.500 MHz. This nominally covers 914.5–924.5 MHz,
so it cannot establish activity on the upper New Zealand channels. The slices
have gaps, including a substantial gap during startup; they are not a continuous
recording. All surviving slices report zero missing USB samples.

The baseline contains the verified 923.118 MHz stream and the experimental
915.190 MHz stream. Both are absent from the off-state slice. After power returns,
the experimental stream appears at approximately **918.060 MHz**, initially
with 30-byte packets and subsequently packets as large as 255 bytes. The verified
923.118 MHz stream returns around the transition to larger experimental packets.
Six analysed startup slices yield **38 complete packets with zero coding parity
errors**. The baseline yields another **11**. All 49 share the same first eight
decoded bytes, supporting a common packet family without verifying station identity.

An initial coarse tuning estimate of 918.190 MHz produced misleading sync symbols
and corrupted payloads. Correct tuning to 918.060 MHz restores **sync [16,8]** and
clean parity. No change of sync word has been established. The browser diagnostics
show observed sync symbols only after the explicit-header checksum passes.

At a receiver centre of 923.125 MHz, the corresponding image appears near
928.190 MHz. Retuning the centre to 922.125 MHz leaves the real stream near
918.060 MHz and moves the image near 926.190 MHz. This is a receiver image,
not evidence of another station or of hopping. Channel selection changed across
the restart, but continuous hopping has not been demonstrated.

The experimental VFO also recovers live headers and payloads at 40 MSPS with
the receiver centre restored to 923.125 MHz. Live reception can still produce
coding parity errors. At the time of that experiment, no application checksum
or RTCM CRC had passed. The RTK2 profile now validates those protocol layers.

### Related RTK 3 protocol clues

VE2MRX's RTK 3 research reports the same basic experimental PHY: SF7, BW250 kHz,
CR4/5, explicit header, preamble16 and no LoRa payload CRC. Its US installation
uses ascending 1 MHz channel steps with 600 ms dwell and a 15-second cycle.
Those timings and channel plans have not been observed in this New Zealand
Luba 2 investigation.

That project describes a four-byte station-address header, a little-endian
CRC16/MODBUS trailer, separate 21-byte beacons marked `55 55 00 40`, and
containers beginning `A5 5A 04 01 04`. Containers carry sequence numbers and
can span radio frames; address headers, checksum trailers and beacons must be
excluded from the correction stream before reassembly.

None of the 49 clean baseline/startup packets passes that whole-frame MODBUS
checksum or contains its beacon or container markers in the expected decoded
format. Nibble-order and whitening-phase checks also produce no matching
structures before undoing the DU1021D transform. RTK2 support now uses its own
validated outer frame and container checksums before displaying GNSS information.

## Live browser workflow

1. Start BrowSDR with `npm run dev` and open <http://localhost:5173/>.
2. Connect LimeSDR, select RX1 and LNAL, and choose 1 MSPS or higher.
3. Open **Tools → RTK**, choose a VFO, and enable **Decode**. Audio can remain
   muted and decoding continues when the panel is closed.
4. The list combines verified bases from all enabled RTK VFOs. Select a row
   to see that base's location and map, satellite counts, GNSS signal quality
   and receiver model. **Decoder settings** controls the selected VFO's profile
   and preset tuning: **RTK1** offers **923.118 MHz** and **RTK2** offers
   **915.191 MHz**, both measured locally. The experimental profiles have no fixed-frequency preset;
   tune its VFO to the active waterfall signal, which can change after a restart.
5. **Save data** offers a station summary (JSON) or a verified correction
   stream (RTCM3), with explanations of both formats. **Diagnostics** contains
   pairing fields, message types, satellite IDs and packet/error counters.

The panel shows a **LoRa number** derived from received packet headers. The
RTK1 wrapper exposes scan, channel and net ID, but the loc field remains
unresolved. For the invented test station it displays `1234.7.?.42` with
**loc unknown**. The decoder does not require a pairing number as input or use
it as a decryption key. A supplied number can help associate an already-decoded
signal with a particular base; it does not enable unsupported payload formats.

RTK2 and RTK3 display the verified 16-bit **LoRa address** instead. RTK2 also
carries an eight-byte network field, but its mapping to the other pairing-number
components has not been established. The UI does not infer these fields from
the tuning frequency or a user-supplied pairing number.

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
a 1 MSPS channel to the LoRa receiver. For a 10 MSPS view covering the measured
signals, use a centre near 919.5 MHz and separate VFOs at 923.118 MHz and the
experimental signal's current frequency (observed at 915.190 and 918.060 MHz).
Use a wider sample span to investigate the full regional band.
Select the lower profile on the second VFO. Its valid-header counter is
diagnostic; unchecked payloads never become verified station or RTCM results.
RTK telemetry currently works with a locally connected SDR, not remote
WebRTC clients.

**Decoder settings** includes a sample timing adjustment in ppm. The measured
500 kHz signal uses +20 ppm; fresh lower-channel captures recover clean coding
parity near +10 ppm, which is now that profile's preset. This compensates
sample timing, not carrier frequency calibration. Another SDR may need a
different value.

### Lower-channel investigation

A fresh 12-second capture at 915.190 MHz recovered 39 explicit headers,
including recurring 30-byte packets and larger packets up to 255 bytes.
The current browser diagnostics show **Payloads recovered** separately from
**Verified radio packets**, and count failed CR4/5 even-parity codewords under
**Coding parity errors**. This parity code can detect an error but cannot correct
it; passing parity is not a checksum or proof of a station identity.

The recovered bytes have not produced checksum-verified RTCM or identified
pairing fields. Standard LoRa coding/whitening and the published RTK3 wrapper
were checked, but that wrapper has not been established for this signal.
The experimental transmitter therefore remains unidentified. Neither encryption
nor Luba 2 compatibility has been established. An initial SF8–10 check near
923 MHz found no valid headers in the short capture; this does not exclude
other parameters, weak signals, or intermittent/hopping transmissions.

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
IDs. The unidentified lower profile has no established application checksum,
so its payload remains untrusted; this does not establish encryption. RTK3's
separate profile validates the documented CRC16/MODBUS frame layer instead.

The implementation uses bounded IQ history, throttled UI messages and
existing worker backpressure. Retunes, profile changes, sample-rate changes
and sequence gaps reset acquisition. No new application dependency is needed.

## Capture files and fixtures

**Tools → IQ Capture** records raw signed IQ with SigMF metadata for further
protocol research and offline demodulation. Choose Seconds or Minutes for the
duration. Captures above 64 MiB open a save dialog in Chrome/Edge and stream
directly to disk, including 8–30 minute recordings. Smaller captures stay in
memory for download. Download the matching `.sigmf-meta` after either capture.
The data is interleaved signed 8-bit I/Q (`ci8`), at the receiver sample rate,
covering the full receiver bandwidth; no additional capture decimation is applied.
For example, at 2 MSPS, 8 minutes is 1.92 GB and 15 minutes is 3.6 GB. Lower the
receiver sample rate if less bandwidth is needed. Keep the tab open and ensure
the disk has enough space and sustained write speed.

Capture buffers are copied before USB reuse. The file write queue is bounded
to 64 MiB; a disk that cannot keep up fails the capture instead of silently
dropping data or accumulating the entire recording in memory. Retuning,
changing gains, stopping reception, or disconnecting cancels the capture.
Incomplete file captures are aborted rather than saved. USB sample loss is
reported in the completion message and SigMF metadata when the device provides
continuity statistics.

RF captures, station exports and screenshots may expose a base's precise
coordinates or pairing identifiers. They are ignored under `output/rtk/` and
must not be used as public fixtures. The test fixture contains only invented
identifiers and mock coordinates. Tests require no private files.
The Storybook **Receiver / RTK Base Stations / Multiple Bases** example uses
only invented identities and coordinates for visual review without hardware.

## References

- [Luba 2 RTK FCC filing, 2A8QJ-RTK0002](https://fccid.io/2A8QJ-RTK0002) and [LoRa test report 7089749](https://fccid.io/2A8QJ-RTK0002/Test-Report/Test-Report-7089749): channel table on page 6; measured 6 dB bandwidth on page 52. FCC exhibits are viewed through a third-party mirror.
- [New Zealand RSM Short Range Devices GURL](https://www.rsm.govt.nz/licensing/frequencies-for-anyone/short-range-devices-gurl) and [linked Gazette notice 2022-go3100](https://gazette.govt.nz/notice/id/2022-go3100): regional 915–928 MHz band reference.
- [Community report of July 2024 Luba 2 firmware radio changes](https://www.reddit.com/r/MammotionTechnology/comments/1ea9yzo/rtk_with_new_firmware_july_23rd_2024/): unverified European frequency-hopping observations.
- [gr-lora_sdr](https://github.com/tapparelj/gr-lora_sdr): PHY reference and independent synthetic waveform generator. Browser decoding uses its own TypeScript implementation.
- [VE2MRX Mammotion RTK research](https://github.com/Ve2mrx/mammotion-rtk-lora): related RTK3 research; its wrapper and hopping assumptions differ from this verified Luba 1 signal.
- [PyMammotion](https://github.com/mikey0000/PyMammotion): scan/channel/loc/net pairing fields.
- [Mammotion positioning information](https://support.mammotion.com/portal/en/kb/articles/about-the-new-positioning-information-and-how-to-troubleshoot-the-related-issues): L1/L2 counts, reference/robot/co-viewing satellites, GNSS quality and positioning status.
- [RTKLIB MSM signal tables](https://github.com/rtklibexplorer/RTKLIB/blob/demo5/src/rtcm3.c): RTCM signal IDs and GNSS frequency bands. Reserved and tentative extension IDs remain unmapped.
