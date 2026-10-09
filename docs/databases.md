# Receiver databases and shared R2 storage

The Worker uses the **DATABASES** R2 binding for independent database namespaces:

| Prefix                  | Contents                                                 | Source                 |
| ----------------------- | -------------------------------------------------------- | ---------------------- |
| `aircraft-db/`          | Immutable aircraft and airline shards and their manifest | OpenSky and Planefence |
| `maritime-db/mids.json` | MID country/administration allocations                   | ITU                    |

Aircraft build scripts and binary filenames keep their feature-specific names.
General storage settings are `DATABASES_BUCKET` for manual uploads and
`DATABASES_PUBLIC_URL` for the public root. The client accepts `VITE_DATABASES_URL`
as the root for all hosted databases. Feature-specific URL and bucket overrides
have been removed; each feature appends its namespace to the shared root.

The physical bucket is **`browsdr-databases`**, in account
`ccd550c603c63502ea824904dd2e5d06`, served by
**`https://db.browser.jlynx.net/`**. The domain is attached directly to R2 and
is independent of the Worker running the scheduled database refresh.
The bucket uses the read-only GET/HEAD CORS policy in `scripts/databases/cors.json`.
Normal setup needs no URL override.

For a local-only client build, set `VITE_DATABASES_URL=/` before starting Vite.
For a different hosted database root, set `VITE_DATABASES_URL` before building
the client and `DATABASES_PUBLIC_URL` before manually publishing snapshots.
These roots contain no credentials; authenticated uploads use Wrangler.

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
