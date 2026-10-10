# VHF ACARS reception

Open **Tools → ACARS Messages**, select a VFO, choose a channel and press
**Tune ACARS channel**, then enable **Decode VFO** and start reception.
The shortcuts include common channels such as 131.550 and 131.725 MHz;
channel usage varies by region and operator. Manual tuning to other VHF channels
between 118 and 137 MHz works too. Use an airband antenna and a compatible SDR.

## Receiver setup

The independent decoder receives a 25 kHz AM channel at 48 kS/s. The complete
48 kHz channel must fit inside the radio's received band; higher sample rates
are channelized by the DSP pipeline. Speaker audio, audio mode, squelch and audio
bandwidth do not configure this decoder. Audio can stay muted.

Tuning follows the normal VFO controls, including radio center changes, conflicts
with other VFOs and remote host locks. Sample rate and audio settings stay as
chosen. Closing the panel preserves decoding; reopen it to disable a VFO.
Decoder enablement is included in saved VFO settings and bookmarks.

BrowSDR receives conventional **2400-baud VHF ACARS**. Only blocks passing character
parity and block checksum validation are displayed; no bit repair is performed.
IQ discontinuities discard partial packets. VDL Mode 2, HFDL and satellite ACARS
reception are unsupported.

## Reading messages

The panel combines up to 200 recent messages across enabled VFOs, newest first.
Search accepts registration, flight, label, message text or decoded fields.
Select a registration to see receipt time, frequency, direction, mode,
acknowledgement, block ID, message number and the full text with line breaks.
Aircraft-to-ground blocks include message number and flight ID; ground-to-air
blocks do not use that header. Received values may be blank. No external aircraft
feed or database is required.

The list shows readable summaries. Details distinguish decoded, partially decoded
and unparsed payloads while preserving the complete original message. A recognized
label identifies a message category; it does not guarantee that the airline's
payload format is decoded.

Supported interpretations include positions, routes, flight events, operations
notes, load reports, weather and clearance messages, link controls and aircraft
report headers. Some application messages contain binary or compressed data;
supported complete payloads are expanded and interpreted locally. Unknown formats,
undocumented measurements and unsupported transfer variants remain available as
raw text. Interpretation runs locally without sending messages to a service.

Examples you may see:

- `_d` with no message text: a link acknowledgement, rather than a readable airline message.
- `3L` with `S 37.306/E174.100 /UTC 0809`: a position report with a reported UTC time.
- `OFF` movement reports: reported takeoff information, with flight and route where available.
- H1 `DF` reports: aircraft monitoring or maintenance data. A recognized header can identify the aircraft, route and report, while numeric measurements remain undecoded.

Airport fields use an offline global ICAO/IATA name lookup. Unknown codes remain
visible. Arbitrary text and ground-station addresses are not treated as airports.
Undocumented numeric scales, units and field meanings are not guessed.

Recognized time codes with a documented UTC interpretation can show UTC and the
viewer's local time. When a date is omitted, an inferred date may use the closest
valid date to reception; it is not an authoritative date supplied by the aircraft.
Times without a verified timezone remain unconverted. Position report times retain
their reported minute precision.

## Continued reports and retransmissions

ETB continuation blocks are retained separately. Complete consecutive downlink
blocks are reassembled within a VFO log when aircraft, mode, label, message-number
prefix and letter sequence agree. Transport block IDs can span unrelated messages
and need not be consecutive within one payload. Exact retransmitted payloads are
counted once during assembly, while their original received blocks remain in the log.

A missing or conflicting block prevents reassembly; final ETX is required.
Assemblies are limited to 26 blocks, 8,192 characters, two minutes between blocks
and five minutes overall. Retransmissions cannot extend the overall time limit.
The final block shows both its original and assembled text. Details explain
assembly failures such as missing starts, sequence mismatches or time/size limits.

Later DF blocks can show context from a recognized first block in the same VFO log,
matched by aircraft, mode and message number within two minutes. These fields are
explicitly attributed to the first block. This association does not establish that
every intermediate block was received or decode the numeric measurements.
A complete unsupported report can therefore still show **Payload undecoded**.

Retuning or restarting a decoder resets its log. Remote receivers decode on the
host and forward results to the requesting client's VFO, including muted VFOs.
Removed, restarted and retuned workers cannot forward old results.

## Exporting a reception log

**Export all JSON** downloads every block still retained across the VFO logs,
including full raw text, line breaks, envelope fields, UTC receipt times,
decoded fields/notes and available reassembled messages. It includes
acknowledgements and retransmissions, regardless of search or selected message.

The file records each source frequency and VFO, including retained sources whose
decoder is currently disabled. Each decoder retains up to 200 blocks. The export
cannot recover discarded history or logs lost on refresh or retuning. Export
before refreshing when collecting a batch for analysis.

## Verification

Automated tests cover synthetic AM/MSK IQ through the production WASM channelizer,
byte and float IQ, phase offsets, chunk boundaries, IQ gaps, CRC/parity rejection,
message interpretation, bounded logs, remote routing and UI controls.
Synthetic tests do not establish aircraft reception or receiver sensitivity;
those require live radio verification.
