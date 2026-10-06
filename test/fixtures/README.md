# P25 conformance vectors

`p25-vectors.json` was generated independently of BrowSDR using
[OP25 p25craft.py](https://github.com/boatbod/op25/blob/master/op25/gr-op25_repeater/apps/tx/p25craft.py)
(Copyright 2011 Michael Ossmann, GPL-2.0-or-later). It implements the
TIA-102.BAAA-A Common Air Interface and was checked by its author against
TIA-102.BAAB-B conformance vectors.

These are synthetic test packets, not received private communications. They use
NAC 0x293, group 0x1234, source 0x123456 and status symbol 1. Included units are
HDU, LDU1, LDU2, TDULC and TDU, plus encrypted-flag variants for mute/status tests.

The channel-coded null IMBE word `6c42e85de2e8269363d981f9be23b18ae006` was
generated from `P25_NULL_IMBE = 040cfd7bfb7df27b3d9e45` in
[MMDVMHost P25Defines.h](https://github.com/g4klx/MMDVMHost/blob/master/P25Defines.h),
using the Golay/Hamming coding, whitening and interleave in
[P25Audio.cpp](https://github.com/g4klx/MMDVMHost/blob/master/P25Audio.cpp).
The OP25 generator flips the IMBE sync bit in alternating voice frames.

The fixture checks physical frame boundaries, status-symbol removal, BCH NID
validation/correction, inner and outer FEC, all nine IMBE positions, polarity
inversion and circular-buffer wrap. `scripts/validate-dsd.mjs --p25-self-test`
passes these packets through the actual Rust/WASM IQ filter, FM discriminator,
timing recovery and mbelib codec. This validates codec/framing with a silence
vector; it does not by itself prove intelligible live speech reception.
