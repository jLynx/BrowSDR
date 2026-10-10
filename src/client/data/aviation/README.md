# Airport reference data

`airports.json` contains every airport with an explicit ICAO or IATA code in
the [OurAirports global CSV](https://ourairports.com/data/). Each row is
`[name, ICAO code, IATA code]`; empty codes are retained as empty strings.
Local identifiers and GPS codes are not substituted for ICAO codes.

The source is public domain. `metadata.json` records source URL, SHA-256 and
record counts. The initial snapshot was retrieved on 10 October 2026.
The lookup is bundled for offline use and preserves unknown codes. Airport
names do not establish the meaning of an airline payload or an ATC unit address.

Update from the official source:

```sh
python scripts/airport-db/build.py
```

To reproduce a snapshot, pass `--input /path/to/airports.csv`. The generator
rejects malformed or ambiguous codes rather than silently naming the wrong airport.
