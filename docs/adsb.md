# ADS-B aircraft reception

BrowSDR decodes 1090 MHz extended squitter (1090ES) ADS-B from a connected SDR.
The receiver's DSP worker demodulates IQ, checks Mode S CRCs, and tracks aircraft;
the browser displays the received aircraft on an interactive map and searchable
list. Remote receivers decode on the host and forward aircraft data to the client.

## Setup

1. Connect an SDR and antenna covering **1090 MHz**.
2. Set the radio center to **1090 MHz** and use at least **2 MS/s**. The complete
   2 MHz decoder channel must fit inside the radio's received band. Higher input
   rates are resampled to 2 MS/s in the existing Rust DSP pipeline.
3. Open **Tools → ADS-B Aircraft**, choose the VFO in its dropdown, and use **Tune VFO … to 1090 MHz** to tune the
   selected VFO, then enable **Decode VFO …** in the tool panel. The shortcut appears only
   in this tool panel and disappears when the selected VFO is already at 1090 MHz.
   Manual tuning works too.
4. Start reception. VFO speaker audio can stay muted. Closing the tool panel
   keeps decoding enabled; reopen it to disable decoding on the selected VFO.

The decoder bandwidth is independent of the VFO's audio bandwidth. Enabling it
does not automatically change the radio frequency, sample rate, or other VFOs.
ADS-B uses pulse-position modulation, not WFM. The selected audio mode does not
configure this independent IQ decoder; leave speaker audio muted for aircraft
reception.
The tuning shortcut follows normal VFO tuning: it can adjust the radio center,
shows the existing conflict dialog if other VFOs cannot fit, and respects remote
host locks. It leaves the sample rate and decoder/audio settings as chosen.
The decoder flag is included in saved VFO settings and bookmarks.

On LimeSDR, an antenna connected to **RX1_H** uses **RX1 / LNAH**. A 5 MS/s input
rate produced valid frames and an airborne map position in the local hardware
test; the short 2 MS/s trial produced no valid frames with that setup. The 2 MS/s
minimum is a decoder requirement, and reception also depends on the antenna,
signal strength, gains, and radio filtering.

## Aircraft list and map

The list stays ordered by ICAO address as messages arrive, keeping existing rows
in place during updates. It shows ICAO address, callsign, altitude in feet, ground speed in knots,
ground track in degrees, and time since the last received message. Unknown fields
appear as a dash. Select an aircraft to highlight it and pan the map to its
position; **Fit aircraft** brings all located aircraft into view. Search accepts
callsigns and ICAO addresses. The map supports zooming, panning, and short trails.
**Fullscreen map** expands the tool across the browser viewport, giving most space
to the map while keeping the aircraft list and details available. Choose **Exit
fullscreen** or press **Escape** to restore the panel. Reception continues during
these layout changes; closing the tool exits fullscreen.

Aircraft silhouettes use the open-source [tar1090](https://github.com/wiedehopf/tar1090)
assets used by OpenSky's map, with its altitude colour palette: orange/yellow at
low altitude, green, blue and purple higher up. Grey means unknown altitude;
selection and stale positions adjust brightness and saturation. A legend shows
altitude in feet. Received ADS-B categories identify helicopters, gliders and
lighter-than-air aircraft; database type information refines other silhouettes.
Helicopter broadcasts take precedence over conflicting database classifications.
Icons rotate with ground track, except lighter-than-air markers.

Hover over a marker for callsign, ICAO, registration, type, airline, operator,
data source, altitude, speed, track, vertical rate, squawk and last seen. Click a
marker for the full details view; touch users can select it the same way. Hover
information updates without reopening the tooltip. Unknown fields show a dash.
Routes, wind and RSSI from OpenSky's map are not available in this decoder.
Silhouettes and mappings are pinned to tar1090 revision
`e784ee5ae82948f41efe3ef5c235ade0943ab8ff`; source attribution and GPL-2.0-or-later
terms are included in `src/client/app/decoders/adsb/map/assets/`.

Positions require an even and odd airborne Compact Position Reporting (CPR)
message from the same aircraft and altitude source within ten seconds. A callsign
or altitude alone does not locate an aircraft. Position markers expire after
30 seconds without a decoded position; aircraft leave the list after two minutes
without a valid message. Each worker and the visible list retain at most 500 aircraft,
and each map trail retains at most 60 positions.

Map backgrounds use [OpenStreetMap](https://www.openstreetmap.org/copyright)
tiles and require internet access. Decoding and the aircraft list work without
map tiles. No aircraft feed, account, API key, or aircraft-data upload is used.

## Aircraft database details

Select a list entry or map marker to open its details beside the map. **Back to
aircraft** returns to the stable list. You can also enter a six-digit ICAO address
in the search box and choose **Look up ICAO** without receiving that aircraft.
**Hide map** gives the details the full panel width.

The details combine received callsign, last seen, altitude, current coordinates,
ground track/speed, vertical rate and squawk with database registration,
manufacturer, model, aircraft type, engine count/type, owner and operator.
Squawk requires a DF17 type-code 28 subtype 1 identity message and retains leading
zeroes. Ground track is the direction of travel, rather than the aircraft's nose heading.
Expired positions appear as unknown, and aircraft that leave the live list are labelled.

Aircraft metadata comes from BrowSDR's database job, built from
[OpenSky Network metadata](https://opensky-network.org/datasets/metadata/aircraftDatabase.csv).
Its companion **airlines.db** supplies the airline and **airline country**, inferred
from a three-letter callsign prefix followed by a flight number. That country
belongs to the airline; it is not the aircraft's current location or necessarily
its registration country. Owner, operator and airline are separate fields.
Three-character classifications such as `L2J` supply the aircraft category and
engine count/type. Other designators are shown as supplied, without guessing engines.

BrowSDR now builds and serves its own versioned snapshot on Cloudflare R2. See
[database builds and hosting](aircraft-database.md) for source, format and job setup.
Lookups download and cache the file for the aircraft's ICAO prefix, verifying its
checksum. Saved files work offline. If the hosted snapshot is unavailable,
lookups use the saved BrowSDR snapshot. Missing records show as unknown. No API key or upload of
received positions is needed. Errors leave live values available and offer a retry;
missing or blank database fields show a dash.
Records may be outdated, and some aircraft have only a registration and type.

Choose **Save offline database** in the tool footer to download the full
aircraft and airline snapshot. The save button disappears when the saved database
is current. Opening the tool and reconnecting to the internet compare the saved snapshot with the published
revision. **Update offline database** appears when a newer revision is
available; the button shows the size calculated from that revision's manifest.
The existing saved snapshot stays available until the update completes.
Browser Cache Storage retains the files across reloads, so previously unseen ICAO
addresses can be looked up without internet access. Browser storage eviction or
clearing site data removes the snapshot; save it again if needed. With the snapshot
available, map markers automatically receive local metadata, including their type
and airline, without making an online request for each aircraft. Offline map tiles
are not included.

The [OpenSky REST API](https://openskynetwork.github.io/opensky-api/) supplies live
state vectors, rather than registration, manufacturer, model, owner or operator
metadata. Its old `/api/metadata/aircraft/icao/…` endpoint returned **410 Gone**
when checked, and its CORS policy excludes this browser app. BrowSDR therefore
uses downloadable OpenSky metadata through its own built database, rather
than attempting that retired endpoint before every lookup. No direct OpenSky
live-feed integration or client credentials are included.

Database files use immutable content-derived revisions, so records from different
updates are never mixed. Downloads are shared and bounded, with at most eight
shards retained in memory. The weekly Cloudflare job checks source hashes and
database content before publishing an update. The generated snapshot is hosted
separately on R2; source data retains its upstream terms.

## Initial scope and validation

Supported messages are CRC-valid **DF17** ADS-B: identification, airborne
barometric/GNSS position, ground speed/track, vertical rate and identity squawk. Barometric altitude
currently supports the common Q=1 encoding; other encodings appear as unknown.
978 MHz UAT, surface position, DF18/TIS-B, Mode S address-parity replies,
multilateration, and airspeed-only velocity messages are outside this initial scope.

Regression tests cover published Mode S examples, corrupted frames, CPR pairing
and expiry, pulse bursts across IQ buffer boundaries, the real Rust DDC at multiple
input rates, receiver controls, remote payload validation, and render isolation.
Generated IQ tests establish decoder correctness for those fixtures; they do not
establish reception sensitivity or sustained throughput with a physical antenna.
