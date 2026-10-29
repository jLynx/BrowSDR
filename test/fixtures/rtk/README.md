# Mock RTK waveform

The tests synthesize IQ in JavaScript from reviewable mock data. No captured
IQ, binary waveform fixture, personal pairing number, serial number or home
coordinates are included.

- `mock-packet.js`: invented scan 1234, channel 7, net ID 42 and RTCM 1006
  station 42 at **0° latitude, 0° longitude**, zero ellipsoid height.
  Multi-base tests use additional invented IDs and **0°, 90°** as a second
  mock reference, including duplicate RTCM station IDs to verify isolation.
- `mock-symbols.js`: test-only whitening, FEC, interleaving, header and CRC
  encoding; it does not import the production decoder.
- `mock-iq.js`: SF7/BW500/CR4-6/LDRO, sync [40,36], preamble 32, payload 248,
  CFO 630 Hz and sample skew +20 ppm. Samples are generated offline in memory.
  Configurable synthetic parameters also exercise SF7/BW250/CR4-5 with LDRO
  off, sync [16,8], preamble 16, +10 ppm and no payload CRC for RTK2. PHY-only
  tests deliberately use arbitrary mock payloads; application tests use
  the separate RTK2 packet fixture.

Tests compare the entire decoded payload with the mock bytes, verify both
checksums and assert the exact invented pairing and reference coordinates.
Keep future fixture changes synthetic and inspectable; do not add RF captures
or decoded files from a real installation to this folder.

## RTK2 synthetic fixtures

`mock-rtk2.js` builds the DU1021D wire transform, CRC8 outer frame and CRC16
correction containers with invented address 4242. Its correction stream tests
exercise fragmentation, keepalives and RTCM CRC24Q verification. The selectable
profiles are `rtk1`, `rtk2` and `rtk3`; the temporary unidentified profile was
removed when its protocol was identified as RTK2.

`du1021d-vectors.json` contains invented inputs and expected outputs obtained
by emulating the original DU1021D ARM Thumb routine at loaded address `0xc36c`
(image offset `0x9b6c`, load base `0x2800`). The radio OTA has SHA256
`cee55312e1ac72310fa74583f4776a6c80d821aa501ba600646b06af3957441b`.
These vectors exercise every short-tail size, complete blocks, mixed blocks,
and the 255-byte radio limit independently of the JavaScript mock transform.
They contain no live payloads, station data, or vendor executable code.

`du1021d-frames.json` adds four complete invented frames. The original radio's
header builder (`0xa908`), CRC8 routine (`0xa274`) and transmit transform
(`0xc4c0`) were emulated with synthetic RAM configuration and a synthetic
correction container. The original receive transform (`0xc36c`) round-tripped
each frame. These addresses use the same `0x2800` load base. The decoded image
has SHA256 `cc83258ff862a8eccd96fdf6176cab41ca78108cb08ac163c597c7e282216c38`.
Unrelated configuration bytes were varied twice per frame without changing
the result. Cases cover zero/maximum loc IDs, maximum net ID, 30/31/37/255-byte
frames and radio sequence 255. The inner container and its CRC16 are synthetic;
this is radio framing coverage, not emulation of the base's GNSS telemetry.

## RTK3 synthetic fixtures

`mock-rtk3.js` models the published RBS03 protocol with invented address 4242
and RTCM references at 0°,0° or 0°,90°. Its standard private sync word 0x12 uses
SF7 bins [8,16]. `mock-iq.js` synthesizes the resulting SF7/BW250 waveform with
CR4/5, preamble16, no LoRa CRC and 0 ppm timing. No RTK3 hardware or captured
traffic was used. These tests check framing and the browser worker path;
they do not establish compatibility with real RTK3 units.
