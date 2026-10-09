# Receiver databases and shared R2 storage

The Worker uses the **DATABASES** R2 binding for independent database namespaces:

| Prefix                  | Contents                                                 | Source                 |
| ----------------------- | -------------------------------------------------------- | ---------------------- |
| `aircraft-db/`          | Immutable aircraft and airline shards and their manifest | OpenSky and Planefence |
| `maritime-db/mids.json` | MID country/administration allocations                   | ITU                    |

Aircraft build scripts and binary filenames keep their feature-specific names.
General storage settings are `DATABASES_BUCKET` for manual uploads and
`DATABASES_PUBLIC_URL` for the public root. Existing `AIRCRAFT_DB_BUCKET` and
`AIRCRAFT_DB_PUBLIC_URL` publisher overrides remain supported.
The client accepts `VITE_DATABASES_URL` as the root for all hosted databases;
`VITE_AIRCRAFT_DB_URL` remains an aircraft-only override.

The current physical bucket remains `browsdr-aircraft-db`, served by
`https://aircraft-db.browsdr.jlynx.net/`. Changing the code binding does not move
objects or rename this bucket. It is already able to hold multiple prefixes.
Retaining the physical name keeps existing deployments, public URLs and offline
aircraft snapshots usable while a migration is prepared.

For a future physical migration to `browsdr-databases` and a general database domain:

1. Create the destination bucket and copy all published prefixes, including old
   immutable aircraft revisions needed by cached clients.
2. Apply the existing GET/HEAD CORS policy from
   `scripts/aircraft-db/cors.json` and attach the new custom domain.
3. Verify manifest and shard downloads and MID lookup through the new domain.
4. Switch Wrangler's `DATABASES` bucket name, publisher settings and
   `VITE_DATABASES_URL`, then deploy together when authorized.
5. Retain the old bucket/domain while old clients still reference it. Do not delete
   old objects or cached browser data as part of a naming change.

No infrastructure migration or deployment is performed just by editing these files.

The weekly scheduled handler refreshes aircraft and MID data independently. Either
source can publish even if the other fails; the handler reports any failures.
The MID updater reads the server-rendered table embedded in the supplied ITU page
at `https://www.itu.int/gladapp/Allocation/MIDs`. It caps the download at 2 MiB,
rejects incomplete tables, preserves shared allocations, hashes normalized sorted contents and
skips writes when unchanged. Publication uses an ETag condition and preserves the
last database on download or parsing failures. The bundled snapshot contains 292
allocations retrieved on 9 October 2026. This is country data, not boat records.

For local fallback refresh, retrieve the ITU table, validate every allocation and
replace `public/maritime-db/mids.json` with schema 1, a content SHA-256 revision
(first 24 hex digits), source URL, retrieval date and the sorted `mids` object.
The browser tries the hosted table, bundled table and previously cached table;
cached data can be evicted by the browser.

See [aircraft database builds](aircraft-database.md) for the existing binary format.
Cloudflare references checked for this change:
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/),
[public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
