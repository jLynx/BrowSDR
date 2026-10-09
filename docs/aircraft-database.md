# Aircraft database builds and R2 hosting

BrowSDR builds its own aircraft and airline snapshots from
[OpenSky's complete aircraft snapshots](https://opensky-network.org/datasets/#metadata/)
and [Planefence airline codes](https://raw.githubusercontent.com/kx1t/planefence-airlinecodes/main/airlinecodes.txt).
Both builders query the public S3 metadata listing used by that page and select
the newest `aircraft-database-complete-YYYY-MM.csv` by its release month. They
follow listing pagination and ignore incomplete `aircraftDatabase.csv` dumps.
OpenSky releases snapshots intermittently; a weekly check does not imply that
new data is published every week. As checked on 9 October 2026, the newest listed
complete snapshot is August 2025 (uploaded 22 August 2025).
The builder uses Python 3.10+ and its standard library. It reads CSV headers,
including the complete dump's single-quote CSV dialect and camelCase names,
rejects invalid addresses, resolves duplicates deterministically, normalizes text
to ASCII and writes sorted fixed-width records compatible with the PortaPack layout.
Source data remains subject to the respective upstream terms; snapshots include
source URLs and SHA-256 hashes in their manifest.
The August 2025 CSV has 32 columns, versus 27 in the older incomplete dump.
Our compact format retains registration, manufacturer, model, aircraft class,
owner and operator; additional columns such as country and SELCAL are not stored.
This snapshot yields 587,144 usable aircraft records, versus 516,505 previously.
Offline download size is calculated from the manifest, so it follows database growth.

Shared aircraft and maritime storage, general URL overrides and the staged bucket
naming migration are described in [receiver databases](databases.md).

## Build and publish

```sh
npm run test:aircraft-db
npm run build:aircraft-db
npm run publish:aircraft-db
```

The builder writes generated files to `public/aircraft-db/` (ignored by Git).
For a local-only build, set `VITE_AIRCRAFT_DB_URL=/aircraft-db/` before starting
Vite. `--aircraft` and `--airlines` accept local input files for reproducible builds.
The normal application uses the public R2 endpoint:
`https://aircraft-db.browsdr.jlynx.net/aircraft-db/`.
`VITE_AIRCRAFT_DB_URL` can override that endpoint; it contains no credentials.
This optional client build setting is passed to the Vite process, for example
`$env:VITE_AIRCRAFT_DB_URL='/aircraft-db/'` in PowerShell before `npm run dev`.
Wrangler's `.dev.vars` supplies Worker secrets and is not read by the Vite client.
Normal setup needs no database URL override.

The R2 bucket is `browsdr-aircraft-db`, in account
`ccd550c603c63502ea824904dd2e5d06`. A custom domain serves the data with read-only
CORS for GET/HEAD. `aircraft-db.browsdr.jlynx.net` is attached directly to this R2
bucket and remains independent of the Worker running the scheduled job.
`scripts/aircraft-db/cors.json` retains the bucket's reusable CORS configuration.
The weekly job uses the main `browsdr` Worker. `publish.mjs` is an optional manual
publisher for locally built snapshots; `AIRCRAFT_DB_PUBLIC_URL` overrides its
manifest-check URL and `AIRCRAFT_DB_BUCKET` overrides its upload bucket.
Uploads use Wrangler's authenticated API. The publishing command
uploads all versioned database files first and the manifest last; a failed upload
leaves the previously published manifest intact. No receiver application deployment
is needed when publishing a new database snapshot.
Before uploading, the publisher reads the current manifest and compares the
content-derived revision. Identical database records skip every R2 write, even
when source formatting, ordering or the build timestamp changes. A failed check
stops publication; only a 404 is treated as a first publication.

Aircraft files are split by the first two hexadecimal ICAO digits, for example
`aircraft-C8.db`. Each file contains a sorted seven-byte key index followed by
146-byte records: registration (9), manufacturer (33), model (33), classification
or type (5), owner (33), operator (33). `airlines.db` uses four-byte keys followed
by 32-byte airline and country fields. Each field is padded with NUL bytes.
Files remain below 25 MiB, allowing static hosting as an alternative to R2.

The manifest names immutable paths under a content-derived revision and records
sizes, counts and SHA-256 checksums. Browsers verify downloaded files and cache
them locally. Only the matching aircraft file is downloaded for a lookup.
**Save offline database** saves the entire snapshot; its completed manifest is
retained for offline use after a later online manifest update. Browser storage
eviction can remove cached files. When the hosted database is unavailable, lookups use the saved BrowSDR snapshot.
Missing records show as unknown; no third-party database fallback is used.

## Scheduled job

`wrangler.jsonc` configures the existing `browsdr` Cloudflare Worker, which serves
the receiver application and runs the database job through its scheduled handler.
Its Cron Trigger runs weekly on Monday at 03:17 UTC.
It writes directly through the `DATABASES` R2 binding, with no GitHub schedule
or API token required. Deploy and inspect it with the existing Wrangler login:

```sh
npm run deploy
npx wrangler tail
```

Each run discovers the newest complete aircraft snapshot, then streams both
upstream files through SHA-256 and compares their hashes
with the published manifest. Identical sources stop before any R2 writes.
Changed sources are downloaded again and compiled in bounded blocks using R2
staging storage. A second content-derived revision check preserves the published
files if source formatting or ordering changed without changing database records.
The job checks that the sources stayed consistent during the build, uploads all
immutable files before the manifest, and uses an ETag condition to avoid replacing
a manifest changed by another publisher. Failures appear in Workers Logs; the
previously published manifest remains available. A listing or source failure
stops the update without substituting the older incomplete dump. The manifest
records the exact dated download URL and source hashes. Temporary staging is removed
when the run finishes. Old published revisions remain usable by cached browsers.

The streaming build uses the Workers Paid plan's CPU and subrequest allowance.
Cloudflare documents a 128 MiB memory limit and a 15-minute duration limit for
scheduled handlers. The job caps source and shard sizes and keeps only one
compiled aircraft shard in memory. Cron changes may take up to 15 minutes to
propagate. The normal project deployment publishes the receiver application and
scheduled handler together. Database refreshes themselves only write to R2.

For local scheduled-handler testing, run `npm run dev:worker` and request
`http://localhost:8788/cdn-cgi/local/scheduled`. Local development uses a local
R2 bucket. After changing its bindings, run `npm run types:worker`.

Current Cloudflare references:
[S3 API](https://developers.cloudflare.com/r2/api/s3/api/),
[custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/),
[CORS](https://developers.cloudflare.com/r2/buckets/cors/),
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
