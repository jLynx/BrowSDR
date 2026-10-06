# mbelib WebAssembly integration

`wrapper.c` and `build.sh` are BrowSDR's integration with the upstream C voice codec
[szechyjs/mbelib](https://github.com/szechyjs/mbelib). The upstream source directory
`mbelib/` is a downloaded cache and is excluded from Git, including upstream native
tests, Google Test/Mock and packaging files.

The compiled files `public/lib/mbelib/mbelib.js` and `mbelib.wasm` are committed,
alongside `COPYRIGHT` and `NOTICE`. Vite copies this directory to `dist/lib/mbelib/`
and Cloudflare Workers serves it as static assets. The browser runs the codec.
`npm install`, `npm run build` and `npm run deploy` do not compile mbelib or need
Emscripten. Keep the licence and notices with the compiled files.

## Pinned inputs

- Upstream commit: `9a04ed5c78176a9965f3d43f7aa1b1f5330e771f` (mbelib 1.3.0).
- Archive: https://codeload.github.com/szechyjs/mbelib/tar.gz/9a04ed5c78176a9965f3d43f7aa1b1f5330e771f
- Archive SHA-256: `c7d6ebbbf3ca44bc10ee0755dede7f74fd65c31d1568d4174f29a68ae2f92278`.
- Rebuild compiler: Emscripten `4.0.7`.
- Compiler flags and compiled source list: `build.sh`.

## Rebuild

Install the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
and activate version 4.0.7. In Bash (Linux, macOS or WSL on Windows):

```bash
# Run these in your emsdk checkout.
./emsdk install 4.0.7
./emsdk activate 4.0.7
source ./emsdk_env.sh

# Then, from the BrowSDR repository root:
bash mbelib-wasm/build.sh
```

`npm run build:mbelib` invokes the same script if Node/npm and the activated SDK
are available in that Bash environment. Bash, curl, tar and either sha256sum or
shasum are required. The first rebuild downloads and verifies the source; later
rebuilds reuse the local source directory. Compilation uses a temporary directory
and replaces the committed outputs only after it succeeds.

When updating the upstream revision, update the commit and checksum in `build.sh`,
these instructions and `public/lib/mbelib/NOTICE`, and remove the cached `mbelib/`
directory before rebuilding. When updating Emscripten, update its pinned version in
the same files. Review upstream licence/notice changes and commit the regenerated
JavaScript and WASM together. Validate with:

```bash
node scripts/validate-dsd.mjs --self-test
npm run build
```
