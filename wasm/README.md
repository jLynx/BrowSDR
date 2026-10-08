# WebAssembly modules

All native decoder sources, build adapters, and committed browser bundles live here.

| Module | Purpose | Browser assets | Rebuild |
| --- | --- | --- | --- |
| `dsp/` | Shared Rust DSP for every SDR device | `dsp/pkg/` | `npm run build:dsp` |
| `mbelib/` | Digital voice codec | `mbelib/pkg/` | `npm run build:mbelib` |
| `rtl433/` | Device protocol decoder | `rtl433/pkg/` | `npm run build:rtl433` |

Run commands from the repository root. DSP requires Rust and wasm-pack; the C
codecs require the pinned Emscripten version described in their READMEs.
Normal application builds use committed bundles and do not compile native code.

Vite serves each module's `pkg/` files at `/wasm/<module>/` in development and
copies them into `dist/wasm/<module>/` for production. Keep licenses and notices
alongside the JavaScript and WASM. DSP also has a generated `node/` bundle for
`npm run test:dsp:bindings`; it is not shipped to browsers.

Downloaded upstream sources, Cargo targets, and CMake build caches remain ignored.
If a CMake cache contains paths from an older checkout location, rebuild in a
fresh build directory.
