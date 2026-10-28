# APRS reception

Open **Tools → APRS**, select a VFO, choose your region's channel and press
**Tune APRS channel**, then enable **Decode VFO** and start reception. Use a 2 m
antenna and a compatible SDR. Audio can remain muted; decoding uses an independent
48 kHz IQ channel in the DSP worker. Closing the panel preserves decoding.

| Channel     | Region           |
| ----------- | ---------------- |
| 144.390 MHz | North America    |
| 144.800 MHz | Europe / Africa  |
| 145.175 MHz | Australia        |
| 144.575 MHz | New Zealand      |
| 144.660 MHz | Japan            |
| 145.570 MHz | Brazil           |
| 145.825 MHz | ISS / satellites |

Regional usage varies; check your national bandplan. Manual tuning works on any
frequency in the 6 m, 2 m, 1.25 m and 70 cm amateur bands, so other 1200-baud
packet channels can be decoded too. Satellite reception does not correct Doppler shift.

## What is decoded

BrowSDR receives **1200-baud Bell 202 AFSK** (VHF/UHF FM packet). Each tone is
level-normalized separately, so transmitter pre-emphasis does not prevent decoding.
Only AX.25 frames passing the CRC-16 frame check sequence are shown; no bit repair is
attempted. IQ discontinuities discard partial frames. 300-baud HF packet, 9600-baud
G3RUH and LoRa APRS are not supported.

Interpreted APRS formats:

- Uncompressed, compressed, Mic-E and raw NMEA (RMC/GGA/GLL) positions, with course,
  speed, altitude, PHG, range and position ambiguity
- Objects and items, including removed (killed) objects
- Messages, acknowledgements, rejections, reply-acks and bulletins
- Status reports, station capabilities and queries
- Telemetry, scaled with the station's PARM/UNIT/EQNS/BITS definitions when received
- Weather reports with or without a position, converted to metric units
- Third-party traffic relayed by gateways, attributed to the original station

Other valid AX.25 frames, including connected-mode packet, appear in the packet log
as raw frames. Unrecognized APRS formats keep their raw information field.
Ambiguous positions are shown at the center of the area the sender reported.

## Reading the panel

**Stations** lists everyone heard across enabled VFOs, newest first. Objects and
items are listed separately from the stations that report them. Select a station to
see its position, motion, comment, status, weather, telemetry, last path and recent
packets. **Packets** shows the latest 200 packets per VFO with decoded summaries and
the raw TNC2-style header and information field; filter by type or search by
callsign, path or text.

Digipeaters retransmit packets within seconds. A packet heard again with the same
source and information within 30 seconds is marked **Repeat** in the log and does
not update the station. Stations expire after 60 minutes without a packet. The map
uses OpenStreetMap and requires internet for uncached tiles.

Remote receivers decode on the host and forward results to the requesting client's
VFO, including muted VFOs. Removed, restarted and retuned workers cannot forward old
results. Retuning or restarting a decoder resets its log.

## Verification

Automated tests cover synthetic AFSK on FM IQ through the production WASM
channelizer, byte and float IQ, carrier offset, noise, tone twist, baud-rate error,
chunk boundaries, IQ gaps, FCS rejection, AX.25 addressing, examples from the APRS
1.0.1 specification, station tracking, remote routing, payload validation and UI
controls. Synthetic tests do not establish receiver sensitivity or reception of
actual stations; that requires live radio verification.

Protocol reference: [APRS Protocol Reference 1.0.1](http://www.aprs.org/doc/APRS101.PDF)
and [AX.25 Link Access Protocol 2.2](https://www.tapr.org/pdf/AX25.2.2.pdf).
