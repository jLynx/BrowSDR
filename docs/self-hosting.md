# Self-hosting BrowSDR

BrowSDR can be hosted at the website root or in a directory such as
`https://example.org/sdr/`. Build for the directory where the app will be served:

```sh
npm run build -- --base=/sdr/
```

Alternatively, put the following in `.env.local` at the repository root. It applies
to both `npm run dev` and `npm run build`:

```dotenv
VITE_BASE_PATH=/sdr/
```

The command-line `--base` overrides `VITE_BASE_PATH`. The default is `/`.
Use an absolute directory path; relative paths and CDN base URLs are not supported.
Rebuild when changing the deployment directory.

Copy the contents of `dist/` into the web server's `/sdr/` directory. Serve
`/sdr/index.html` at `/sdr/`, and redirect `/sdr` to `/sdr/` while preserving query
parameters. The service worker and installed PWA are scoped to that directory.
Assets, decoder WASM, media artwork and receiver sharing links use the same base.

## Server requirements

WebUSB requires HTTPS or localhost and a supported browser. Serve JavaScript with
a JavaScript MIME type and `.wasm` files with `application/wasm`.
Configure these response headers for the app and its assets:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The Cloudflare Worker supplies these headers automatically. A static web server
must supply them itself so SharedArrayBuffer and the receive pipeline can work.

## Backend endpoints

By default, the frontend requests backend endpoints below its base directory:
`/sdr/api/geo`, `/sdr/api/turn`, and `/sdr/hf-proxy/...`.
Static file hosting alone does not provide these endpoints. Country lookup,
configured TURN relays and the production transcription model proxy need the
Worker or an equivalent backend. Local USB reception runs in the browser.

To use a backend mounted elsewhere, set its base URL before building:

```dotenv
VITE_BACKEND_URL=/
```

This example keeps the APIs at `/api/...` and the model proxy at `/hf-proxy/...`
while the frontend lives at `/sdr/`. An absolute URL such as
`https://backend.example.org/` is also supported; that server must provide the
appropriate CORS and cross-origin resource headers for the app.

Shared receiver metadata still uses the configured `VITE_DATABASES_URL`, defaulting
to the public BrowSDR database service. Bundled AIS and BLE database fallbacks
are loaded from the app directory.

## Cloudflare Worker in a subdirectory

Build with `VITE_BASE_PATH=/sdr/` and configure the Worker's `BASE_PATH` variable
to `/sdr/` in your Wrangler configuration. Keep the assets binding pointed at
`dist/`; the Worker maps public `/sdr/...` requests to files at the binding root,
handles the prefixed APIs and proxy, and redirects `/sdr` to `/sdr/`.
Route the Worker to `/sdr` and `/sdr/*` when sharing a hostname with another site.
Requests outside the configured directory return 404. The default Worker base
is `/`, matching the default frontend build.

For local frontend development, `npm run dev` proxies endpoints under the selected
base to the default Worker at `http://localhost:8788`. Run `npm run dev:worker`
with its default root mount, or point `VITE_BACKEND_URL` at your own backend.
