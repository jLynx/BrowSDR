# AIS vessel reception

Open **Tools → AIS Vessels**, select a VFO, choose **Tune AIS A** (161.975 MHz)
or **Tune AIS B** (162.025 MHz), then enable **Decode VFO**. Use two VFOs to
receive both channels, with the radio centered near 162 MHz and both channels
inside its received band. A marine VHF antenna and a compatible SDR are required.
Audio can remain muted; decoding uses an independent IQ channel in the DSP worker.
Closing the tool preserves its decoder configuration and reception.

The initial decoder supports CRC-checked 9600-baud GMSK/NRZI radio reception,
HDLC framing and bit stuffing. It interprets Class A position reports (1/2/3),
Class B position reports (18/19), static/voyage reports (5), Class B static reports
(24 A/B) and long-range reports (27). Other valid message types count toward the
frame total but are not displayed as vessels. Base stations, aids to navigation,
SAR aircraft, binary applications and safety-message interpretation are not part
of this initial implementation.

The list is ordered by MMSI and combines reports received on both channels.
Select a vessel to see its transmitted name, callsign, IMO number, ship type code,
navigation status, destination, draught, speed, course and heading where available.
Unavailable AIS coordinates and movement values are shown as unknown.
Vessel positions expire after three minutes; vessels expire after ten minutes.
Static identity reports can arrive several minutes after the first position report.
The map uses OpenStreetMap and requires internet for uncached tiles. Country
allocations are cached locally, with a bundled ITU snapshot as a fallback.

The [ITU MID table](https://www.itu.int/en/ITU-R/terrestrial/fmd/Pages/mid.aspx)
maps Maritime Identification Digits to the allocating country or administration.
It is **not a vessel registry**. Names and voyage details come from received radio
messages. Country lookup does not imply the vessel's current location, owner or
registration history. See [database hosting](databases.md) for storage and refreshes.

Remote receivers forward AIS snapshots for each client's configured VFO, including
muted VFOs. Old worker messages are rejected after removal, restart or retuning.
IQ discontinuities discard partial packets; no error correction or bit repair is
applied to failed CRCs.

Automated tests cover synthetic Gaussian-shaped IQ through the production WASM
channelizer, corrupt frames, chunk boundaries, IQ gaps, message fields, remote
routing and UI controls. These do not establish reception sensitivity or successful
reception of actual vessels. Real radio verification needs traffic within range.

Live verification on 9 October 2026 received vessel positions and static names
with a HackRF One at 10 MSPS, centered on 162 MHz, using both AIS channels with
audio muted. Valid CRC-checked frames arrived on each channel, and MID lookup
identified New Zealand and Singapore vessels. This establishes reception with
that setup; it does not quantify sensitivity or performance across other devices.

Protocol reference: [GPSD AIVDM/AIVDO field documentation](https://gpsd.gitlab.io/gpsd/AIVDM.html).
Upstream MID data remains subject to [ITU terms](https://www.itu.int/en/Pages/terms-of-use.aspx).
