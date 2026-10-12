# Airport reference data

The lookup delegates to `@jlynx_/acars-decoder/airports`. Its optional offline OurAirports
snapshot covers every record with explicit ICAO or IATA codes: 11,764 airports,
10,531 ICAO codes and 9,051 IATA codes in the 10 October 2026 snapshot.
Unknown codes remain unchanged. Local/GPS identifiers are not treated as ICAO.

Source hashes, metadata, generators and exhaustive data tests live in the
`acars-typescript-decoder` library repository. Update the published dependency with `npm update @jlynx_/acars-decoder`;
the library maintains the source snapshot.
The source is public domain: https://ourairports.com/data/.
