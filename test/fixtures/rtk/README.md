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
  off, sync [16,8], preamble 16, +10 ppm and no payload CRC. These bytes are
  mock input, not a claim that the unidentified lower signal uses the same
  application wrapper as the verified profile.

Tests compare the entire decoded payload with the mock bytes, verify both
checksums and assert the exact invented pairing and reference coordinates.
Keep future fixture changes synthetic and inspectable; do not add RF captures
or decoded files from a real installation to this folder.

## RTK3 synthetic fixtures

`mock-rtk3.js` models the published RBS03 protocol with invented address 4242
and RTCM references at 0°,0° or 0°,90°. Its standard private sync word 0x12 uses
SF7 bins [8,16]. `mock-iq.js` synthesizes the resulting SF7/BW250 waveform with
CR4/5, preamble16, no LoRa CRC and 0 ppm timing. No RTK3 hardware or captured
traffic was used. These tests check framing and the browser worker path;
they do not establish compatibility with real RTK3 units.
