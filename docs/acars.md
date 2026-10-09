# VHF ACARS reception

Open **Tools → ACARS Messages**, select a VFO, choose a channel and press
**Tune ACARS channel**, then enable **Decode VFO** and start reception.
The shortcuts include common channels such as 131.550 and 131.725 MHz;
channel usage varies by region and operator. Manual tuning to other VHF channels
between 118 and 137 MHz works too. Use an airband antenna and a compatible SDR.

The independent decoder receives a 25 kHz AM channel at 48 kS/s. The complete
48 kHz channel must fit inside the radio's received band; higher sample rates
are channelized by the existing DSP pipeline. Speaker audio, audio mode,
squelch, and audio bandwidth do not configure this decoder. Audio can stay muted.
Tuning follows the normal VFO controls, including radio center changes, conflicts
with other VFOs and remote host locks. It leaves sample rate and audio settings
as chosen. Closing the panel preserves decoding; reopen it to disable a VFO.
Decoder enablement is included in saved VFO settings and bookmarks.

The initial decoder supports conventional **2400-baud VHF ACARS**, using AM
envelope detection, 1200/2400 Hz MSK tone detection, differential bit decoding,
SYN/SOH framing, odd character parity and ACARS block check sequences
(CRC-16/KERMIT). Only valid blocks are displayed; no bit repair is performed.
IQ discontinuities discard partial packets. VDL Mode 2, HFDL and satellite
ACARS are outside this implementation.

The panel combines up to 200 recent messages across enabled VFOs, newest first.
Search accepts registration, flight, label or message text. Select a registration
to see receipt time, frequency, direction, mode, acknowledgement, block ID,
message number and the full text, preserving line breaks. Aircraft-to-ground
blocks include message number and flight ID; ground-to-air blocks do not use
that header. These values come from radio messages and may be blank. No external
aircraft feed or database is required.

ETB continuation blocks are marked and displayed separately; application payload
interpretation and multi-block reassembly are outside the initial scope.
Retransmissions are retained. Retuning or restarting a decoder resets its log.
Remote receivers decode on the host and forward results only to the requesting
client's VFO, including muted VFOs. Removed, restarted and retuned workers cannot
forward old results.

Automated verification covers synthetic AM/MSK IQ through the production WASM
channelizer, byte and float IQ, phase offsets, arbitrary chunk boundaries, IQ
gaps, CRC/parity rejection, field extraction, bounded logs, remote routing and
UI controls. Synthetic verification does not establish actual aircraft reception
or receiver sensitivity; live radio verification remains necessary.

Protocol references: ARINC 618 air/ground character-oriented protocol;
[acarsdec framing and field definitions](https://github.com/TLeconte/acarsdec).
