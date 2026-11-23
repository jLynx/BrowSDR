# Remote IQ sharing

Remote receivers can choose **Source → Decode on → This device (IQ)** when the
host supports IQ sharing. The host captures the SDR, generates the full-band
spectrum/waterfall, and filters/resamples one complex IQ slice per active VFO.
The listener runs BrowSDR's normal audio and decoder pipeline on those slices.
Clicking elsewhere in the waterfall changes the slice sent for that VFO.

**Host (audio)** keeps the existing host-decoded audio and message sharing.
Older hosts and clients continue using that mode. The choice is per receiver,
so different listeners can use different decoding modes on the same host.

## Bandwidth

Remote IQ streams always use **8-bit IQ**, enforced by the host even when an
older client requests 16-bit samples. Each complex sample has one I and one
Q value. Host capture and local processing retain their selected precision;
only the outgoing IQ slice is quantized to 8 bits. The estimate under the
controls totals every active VFO's IQ payload; waterfall, packet headers,
encryption and network overhead are additional.

For a 20 MSPS source and one ordinary 150 kHz WFM VFO, the slice runs at
250 kSPS: **4 Mbps of IQ8 payload**. Five listeners with one
such VFO each need about 20 Mbps of host IQ upload, plus overhead and five
waterfall streams. At 20 waterfall frames/second, each 2048-bin waterfall adds
approximately 0.33 Mbps before network overhead.

A short same-PC WebRTC benchmark using LimeSDR at 20 MSPS measured 4.62 Mbps
for one client with one mono WFM IQ8 VFO, 23.06 Mbps for five such clients,
and 65.73 Mbps for five clients with three VFOs each, including waterfall and
browser-reported transport overhead. The last configuration had no steady
IQ drops or playback gaps; an earlier IQ16 experiment reached 124.13 Mbps and
developed playback gaps. IQ16 streaming is no longer offered. These measurements do not establish Raspberry Pi
capacity or internet latency.

Slice planning preserves independent decoder channels even when the listening
audio filter is narrow. With a sufficiently wide captured band:

| Mode / decoder                           | RF preserved by the transport                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| NFM, AM, USB, LSB, DSB, CW, RAW, DSD     | Selected passband and the mode's required sample rate; USB/LSB preserve the carrier offset |
| WFM                                      | Selected passband; stereo preserves at least 200 kHz                                       |
| RDS                                      | At least 250 kHz, separate from the WFM audio filter                                       |
| HD Radio                                 | Full 400 kHz station and at least 744.188 kSPS                                             |
| POCSAG / GSC / FLEX                      | Independent 15 / 12.5 / 18 kHz decoder passbands                                           |
| Wireless Sensors (rtl_433)               | Configured decoder sample rate and its 80% RF passband                                     |
| ADS-B / BLE                              | At least 2 MHz                                                                             |
| AIS / ACARS                              | At least 25 kHz, with a 48 kSPS decoder channel inside the slice                           |
| Radiosonde (RS41)                        | At least 20 kHz, with a 48 kSPS decoder channel inside the slice                           |
| APRS                                     | At least 16 kHz, with a 48 kSPS decoder channel inside the slice                           |
| Fixed RTK profiles                       | At least 1 MHz in this initial implementation                                              |
| RTK Auto, discovery/scanning, or hopping | The full captured band, so the client can search and follow signals                        |
| Whisper                                  | Runs locally on each VFO's decoded audio; adds no IQ bandwidth of its own                  |

RS41 with a normal narrow NFM VFO uses a 50 kSPS slice, approximately **0.8 Mbps
at 8 bits**, plus waterfall and overhead. Wider audio
filters or additional enabled decoders can increase the slice rate.

## Latency and limits

The **Source** panel shows live sharing upload and download, updated every
second. On a host, these are totals across all connected clients and SDRs;
on a client, they cover all received SDRs. Both decoding modes are measured,
including IQ or audio, waterfall, control messages and browser-reported WebRTC
transport overhead. These are measured bytes transferred, rather than requested
IQ capacity or machine-wide internet usage. The separate IQ payload estimate
describes the configured slices and excludes waterfall and network overhead.
New connections briefly show **Measuring…** while counters establish a baseline;
unsupported browser statistics show **Unavailable**.

IQ packets contain at most 3000 complex samples and cover at most 20 ms of
signal. WebRTC transmission and client audio buffering add latency. Network
queues are bounded; when the connection or client cannot keep up, packets are
dropped and the DSP resets across the gap. Audio can briefly interrupt and a
digital decoder may lose the affected frame. Tuning invalidates queued slices
for the old VFO configuration.

All VFOs must fit within the host's captured band. Clients can tune independently
within that band; changing the hardware center or sample rate still follows the
host's existing locks. Pausing a client stops local reception; disconnecting
removes its host workers.

The host still performs USB capture, FFTs, filtering and resampling. It extracts
each remote VFO separately, so host cost grows with VFO count. Moving decoding
to clients reduces that part of the host workload; Raspberry Pi capacity and
five-client performance still require hardware measurements. Identical slices
are not yet shared between clients. Wide decoders and RTK scanning can still
need substantial bandwidth.

RTK hopping currently sends the full capture per VFO. At 20 MSPS this is
320 Mbps of IQ8 payload per follower. Recorded RTK2/RTK3 signals followed hops
through sequential codec/worker replay, but real-time WebRTC replay overloaded
delivery and recovered no remote corrections in the hopping tests. Fixed
RTK1 recovered corrections at approximately 34 Mbps with some dispatch drops.
Reliable remote hopping needs further stream scheduling and bandwidth work.
Remote BLE hardware channel scanning also remains unavailable because it
retunes the physical host radio.

The transport uses the existing PeerJS/WebRTC connections, with separate
full-band waterfall delivery and receiver/VFO routing. This does not implement
an IP-address LAN service or IQ compression.

## Manual testing

1. Start an SDR on the host and share its existing link.
2. Open the link in another browser/device. Confirm **This device (IQ)** is
   selected and the full captured waterfall remains visible.
3. Unmute a VFO, tune it within the capture, and try multiple VFOs and decoders.
4. Switch **Host (audio)** / **This device (IQ)**. Check audio, decoded messages
   and the fixed 8-bit IQ payload estimate. Host capture precision remains
   independent of the remote stream.
5. Remove a middle VFO, stop/start reception, and retune/restart the host. Confirm
   streams still reach the correct VFO and reconnect successfully.

Automated tests include real-WASM channel isolation/amplitude checks,
analogue audio pitch, and generated radio frames for RDS, POCSAG, GSC, FLEX,
AIS, ACARS, APRS, ADS-B, BLE, RS41 and a Waveman rtl_433 payload through both
transport precisions. Translated slices preserve their wanted carrier at DC;
full-band input keeps normal DC removal. Optional private recording tests
exercise RTK hopping and HD Radio through the actual extractor/codec and
client worker with sequential simulated delivery. DSD coverage acquires DMR
data synchronization with a mocked vocoder; intelligible digital voice and
Whisper model inference are not verified by those tests. These checks do not
establish live RF decoding for every protocol or WAN performance.
