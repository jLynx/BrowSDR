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
Search accepts registration, flight, label, message text or decoded fields. Select a registration
to see receipt time, frequency, direction, mode, acknowledgement, block ID,
message number and the full text, preserving line breaks. Aircraft-to-ground
blocks include message number and flight ID; ground-to-air blocks do not use
that header. These values come from radio messages and may be blank. No external
aircraft feed or database is required.

The list includes readable summaries; details distinguish decoded, partially
decoded and unparsed formats and retain the complete raw message. A recognized
label category is shown separately from successful payload decoding. Standard
labels explain flight events, clearance messages, link controls and aircraft
application reports even when their payload layout is unknown.

Payload interpretation integrates the MIT-licensed
[@airframes/acars-decoder 1.9.2](https://github.com/airframesio/acars-decoder-typescript),
covering dozens of documented formats across airlines and aircraft equipment.
These include decimal and compact position reports, route/ETA and out/off/on/in
events, flight briefings, dispatch and door events, load sheets, ATIS
subscriptions, operational flight plans, ARINC 702 reports, fault logs, warnings
and ground-station squitters. Fixed-width standard Q-label events have additional
validation. Explicitly tagged flight, route, time, fuel and measurement fields
can also be extracted from other reports; this fallback does not infer numeric
scales or units. Parsed results are cached with a bounded cache. Interpretation
runs locally without sending messages to Airframes or another service.

The existing specific interpretations include `_d` acknowledgements, version-0 `SA` media/link
advisories, label-3L decimal-degree position reports such as
`S 37.306/E174.100 /UTC 0809`, a recognized label-10 `OFF` takeoff report layout, label-49 report
headers, and H1 `DF` report headers. NZAA and ZBAA have built-in airport names;
other airports keep their ICAO codes. Airline-specific numeric measurements
and undocumented fields are not assigned meanings or units.

Recognized airline layouts also include label-1L `WX RCVD TXOPS NORMAL...`
operations notes, label-2L `DAT ... UTC ... REG ... FLT ...` flight/load reports,
and Airbus H1 `DF` headers beginning with an aircraft type and `REP.../CC...`.
These identify weather receipt, normal operations, reported flight/registration,
dates and routes where provided. An ETA without a timezone stays unconverted.
Semicolon-delimited Airbus `REP...;H01...;H02...;H03...` reports identify the
aircraft/report header, route, flight code and transmitted event text, such as
“Normal Landing Gear Retraction.” The compact H01 date/time layout remains raw.
These maintenance reports are handled by the local header parser; the Airframes
library does not decode their report-specific numeric measurements. Recognition
of `DF` alone is displayed as **Payload undecoded**, rather than partial decoding.
Load values and crew identifiers are displayed as transmitted; weight/fuel
scales and units, LOG/LDR/DRT fields, and Airbus numeric measurements remain
undecoded. Two-digit report years use 2000–2099; Airbus headers that omit the
year use the closest valid year to reception. Duplicate reports remain separate.

The combined TypeScript payload parser keeps Airframes airline formats and adds
logic adapted from the MIT-licensed C [libacars](https://github.com/szpajder/libacars),
Rust [datalink](https://github.com/xoolive/datalink) and Python
[Skyshark](https://github.com/ckuethe/skyshark) implementations. License notices are
included in `public/licenses/acars.txt`. No Python service or external decoding
API is needed. Additional layouts include general aviation positions, explicit
decimal positions, frequency-change instructions and named MDC engine trend
measurements with their transmitted units.

ARINC 622 envelopes identify CPDLC connection/control messages and ADS-C data,
including ground/aircraft addresses and hexadecimal application data. Binary
decoding requires a verified inner ARINC CRC. Failed checksums retain the envelope
and raw data but suppress binary field decoding. ADS-C decodes position, altitude,
time within the hour, flight/airframe identification, velocity, weather, projected
waypoints, events, acknowledgements, noncompliance and uplink surveillance contracts.
FANS CPDLC decodes message headers, catalogue phrases, supported altitude, time,
position, speed, heading, frequency, free-text, procedure and position-report
parameters, including consecutive message elements. Unsupported route-clearance
bodies and other layouts remain partial; catalogue recognition does not imply
their parameters were decoded. H1 sublabels and message function
identifiers are shown when present. A label alone does not guarantee a particular
airline payload format. Unsupported or malformed formats remain unparsed.

The specific parsers show recognized time codes in UTC and the viewer's local
timezone, inferring omitted dates using the closest valid date to reception.
These are not authoritative dates supplied by the aircraft. Community formats
with time-only fields show UTC time without inventing a calendar date. An ETA
with no documented timezone remains unconverted. Position report times retain
their reported minute precision.

ETB continuation blocks are retained separately. Complete consecutive downlink
blocks are reassembled within a VFO log when aircraft, mode, label, message-number
prefix, letter sequence and numeric block sequence agree. Exact retransmissions
are ignored during assembly. A missing or conflicting block prevents reassembly;
the final ETX is required. Assemblies are limited to 26 blocks, 8192 characters,
two minutes between blocks and five minutes overall. The final block displays
both its original text and the assembled text, interpreted through the same
combined parser. Community payloads now accept bounded assembled messages beyond
the single-block 240-character limit.
Within each VFO log, later DF blocks can show context from a recognized first
block, matched by aircraft, mode and the three-character message number within
two minutes. These fields are explicitly attributed to the first block. This
association does not prove that every intermediate block was received and does
not decode numeric sections. It remains useful when reassembly is unavailable.
Compressed MIAM (label MA) and OHMA transfers are identified but not expanded.
Proprietary maintenance numeric columns remain undecoded. The A380 semicolon
report 020 header/event text is recognized, but none of the inspected reusable
sources supplies its A20/A21/etc. measurement dictionary. Application checksums
outside the binary ARINC parser remain extracted values rather than verified checks.
Retransmissions are retained. Retuning or restarting a decoder resets its log.
Remote receivers decode on the host and forward results only to the requesting
client's VFO, including muted VFOs. Removed, restarted and retuned workers cannot
forward old results.

Automated verification covers synthetic AM/MSK IQ through the production WASM
channelizer, byte and float IQ, phase offsets, arbitrary chunk boundaries, IQ
gaps, CRC/parity rejection, field extraction, bounded logs, remote routing and
UI controls. A representative corpus from the Airframes tests covers dozens of
airline formats, alongside standard-label and malformed-payload checks.
Synthetic verification does not establish actual aircraft reception
or receiver sensitivity; live radio verification remains necessary.

Protocol references: ARINC 618 air/ground character-oriented protocol;
[acarsdec framing and field definitions](https://github.com/TLeconte/acarsdec),
[libacars ARINC 622 and media advisory decoders](https://github.com/szpajder/libacars),
and [Airframes message-format research](https://github.com/airframesio/acars-message-documentation).
