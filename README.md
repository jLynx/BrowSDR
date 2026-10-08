# 📻 [BrowSDR](https://browsdr.jlynx.net)

[![BrowSDR Live](https://img.shields.io/badge/Live-browsdr.jlynx.net-success?style=for-the-badge&logo=cloudflare)](https://browsdr.jlynx.net)
[![Rust](https://img.shields.io/badge/Rust-High%20Performance-orange?style=for-the-badge&logo=rust)](https://www.rust-lang.org/)
[![WebAssembly](https://img.shields.io/badge/Wasm-Powered-blue?style=for-the-badge&logo=webassembly)](https://webassembly.org/)

A blazing fast, next-generation browser-based Software Defined Radio (SDR) receiver for HackRF, HackRF Pro, RTL-SDR, Airspy, and LimeSDR devices. Connect a compatible SDR directly to your browser via WebUSB and tune into FM, AM, SSB, CW, and more — **no drivers, no native software, no hassle.**

---

## ✨ Features

Enjoy the power of a desktop SDR platform fully within your web browser.

* **🎯 Multi-VFO Mastery**
  Tune into multiple frequencies simultaneously! Create an unlimited number of Virtual Frequency Oscillators (VFOs), each with independent demodulation, volume, squelch, and DSP settings. Listen to multiple broadcasts without dropping a single packet.
* **⚡ High-Speed Rust & WASM Architecture**
  Built for raw performance. FFT and DSP pipelines are written in **Rust** and compiled to **WebAssembly (WASM)**. Running inside Web Workers off the main thread ensures a crystal-clear, smooth UI and buttery 60 FPS performance, even with multiple active VFOs.
* **🎙️ Live Transcribe**
  Built-in AI-powered live transcription of demodulated audio right in your browser.
* **📟 POCSAG Decoder**
  Instantly decode paging networks straight from the UI.
* **🌡️ rtl_433 Sensor Decoder**
  Live browser-side OOK/FSK decoding for supported weather sensors, remotes, TPMS,
  and other ISM devices. See
  [the decoder build and reception guide](rtl433-wasm/README.md).
* **📊 Frequency Activity**
  Visually spot active signals and quickly jump to transmissions using the dynamic frequency activity scanner and interactive waterfall display.
* **🔖 Advanced Bookmarking System**
  Save, organize, and quickly recall your favorite frequencies. Group your bookmarks into custom categories to effortlessly manage airbands, ham frequencies, repeaters, or emergency services.
* **🌊 Real-time WebGL Waterfall & Spectrum**
  Monitor the entire RF band visually with an ultra-responsive, GPU-accelerated waterfall and spectrum analyzer.
  Waterfall scrolling and spectrum smoothing are time-based: higher FPS makes animation smoother without speeding up the history. The 512-row waterfall retains approximately 25.6 seconds of continuous reception at every target.
* **📻 Wide Demodulation Support**
  Supports WFM, NFM, AM, USB, LSB, DSB, CW, and raw IQ modes.
* **📡 RDS Decoding on the Fly**
  Instantly decode station name, programme type, and radiotext on WFM signals.
* **🎛️ Full DSP Toolset**
  Control squelch, noise reduction, de-emphasis, and stereo output per VFO.
* **🌐 Remote Access**
  Share your SDR with others via WebRTC using PeerJS.

---

## 🚀 How It Works

1. **WebUSB** — Communicates directly with your supported SDR device from Google Chrome or Edge.
2. **WebAssembly** — Signal processing (FFT, filtering, decimation, mixer, demodulation) is handled by [RustFFT](https://github.com/awelkie/RustFFT) and highly optimized Rust code compiled to WASM.
3. **Web Workers** — Multi-threaded DSP via [Comlink](https://github.com/GoogleChromeLabs/comlink) keeps the event loop entirely free of blocking tasks.
4. **WebGL** — Hardware-accelerated FFT rendering.
5. **Vue 3** — A sleek, reactive UI powering complex per-VFO controls.
6. **Cloudflare Workers** — Fast edge-deployed static assets and API proxy.

*(Note: WebUSB requires a secure context — HTTPS or `localhost`)*

---

## 📡 Supported Devices

BrowSDR includes receive drivers for the following device families. Driver availability does not mean every model, firmware version, or feature has been hardware-tested.

| Device family | Models / variants | Notes |
|---------------|-------------------|-------|
| **HackRF** | HackRF One, HackRF Pro | Uses the HackRF WebUSB driver; compatible devices using the same protocol and recognized USB IDs may also work. |
| **RTL-SDR** | RTL-SDR Blog V3 and V4, compatible Nooelec and generic RTL2832U dongles | Supports R820T, R820T2, R828D, E4000, FC0012, FC0013, and FC2580 tuners. Includes Blog V4-specific tuner configuration. Compatibility depends on the tuner and recognized USB ID, not just the brand. |
| **Airspy** | Airspy One, R2, Mini | Includes an Airspy receive driver with device-reported sample rates. |
| **Airspy HF+** | Airspy HF+ family | Includes a separate HF+ receive driver; individual variants still require hardware verification. |
| **LimeSDR** | LimeSDR-USB | Uses the LimeSDR WebUSB receive driver with gain and antenna controls. See the Windows setup below. |

Use a WebUSB-capable browser such as Chrome or Edge, over HTTPS or `localhost`. On Windows, the SDR's USB interface may need **WinUSB** instead of a vendor or DVB-T driver. Close other applications using the device before connecting.

---

## 🧰 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | TypeScript, Vue 3 (Options API), Vite |
| DSP | Rust, RustFFT, WebAssembly, Web Workers |
| Deployment | Cloudflare Workers (Wrangler) |
| Testing | Vitest, wasm-bindgen-test, cargo test |

---

## 🛠️ Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | Build & dev server | Download from website |
| [Rust](https://rustup.rs/) | Compile WASM module | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| `wasm32-unknown-unknown` target | Rust → WASM | `rustup target add wasm32-unknown-unknown` |
| [wasm-pack](https://rustwasm.github.io/wasm-pack/) | Build & package WASM | `cargo install wasm-pack` |
| [cargo-make](https://github.com/sagiegurari/cargo-make) | Task runner for Rust builds | `cargo install --force cargo-make` |
| A WebUSB-capable browser | Run the app (e.g., Google Chrome) | — |

---

## ⚙️ Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Build the WASM module (first time or after Rust changes)
cd hackrf-web && cargo make build && cd ..

# 3. Start the local dev server
npm run dev
```

Then open **[http://localhost:5173](http://localhost:5173)** in Google Chrome or any WebUSB-supported browser.

### LimeSDR-USB on Windows

WebUSB requires the LimeSDR-USB to use **WinUSB**, rather than the native Cypress **CYUSB3** driver. If connecting fails with **Access denied**, check the driver for the LimeSDR in Device Manager and close other SDR applications or browser tabs using it.

Use Device Manager to select an already-installed WinUSB driver, or install one for **LimeSDR-USB only** using [Zadig](https://zadig.akeo.ie/). Do not replace drivers for USB hubs or unrelated devices. Reconnect the device and select it again in Chrome or Edge after changing the driver.

Changing to WinUSB can affect native SDR applications that require CYUSB3; switch back to the previous driver when those applications need it. See [Chrome's Windows WebUSB requirements](https://developer.chrome.com/docs/capabilities/build-for-webusb#windows).

LimeSDR-USB reception supports sample rates up to **61.44 MSPS**. Higher rates require a USB 3 connection and enough CPU capacity for the selected VFOs; reduce the sample rate if audio breaks up or the browser cannot keep up. The driver uses 2× internal oversampling and adjusts the analog receive filter to match the selected rate.

Choose **RX1** or **RX2** using **RX Channel** in the Radio panel, then select **LNAH**, **LNAL**, or **LNAW** under **Antenna** to match the H, L, or W connector in that receiver's antenna group. One receiver is streamed at a time; switching briefly restarts reception while retaining the current frequency, gains, and antenna path. The receiver and antenna selections are saved locally.

### Automatic receive gains (LimeSDR and HackRF)

Use **Auto set gains** while receiving to adjust LimeSDR LNA, TIA and PGA, or
HackRF LNA, VGA and RF amplifier, from
sampled raw ADC RMS, peak and clipping measurements. It targets about −22 dBFS
RMS with at least 6 dB peak headroom, applies bounded adjustments, then holds the
result steady. This is a receiver-wide setting shared by all VFOs. It works with
muted audio.
Cancel keeps the last applied gains; a measurement or USB error attempts to
restore the starting gains. Manual gain controls remain available afterward.
PGA displays its actual gain (register value minus 12 dB).

HackRF uses signed 8-bit IQ samples for these measurements. LNA changes in 8 dB
steps (0–40 dB), VGA in 2 dB steps (0–62 dB); gain staging keeps them roughly
balanced, following [HackRF's gain recommendations](https://hackrf.readthedocs.io/en/latest/setting_gain.html).
The RF amplifier is enabled only when levels remain low after substantial LNA/VGA
gain, and disabled on ADC overload. Before enabling it, downstream gain is reduced
to limit the level jump; fresh measurements account for its frequency-dependent
gain. The existing **Amp (14dB)** label refers to this switch; current HackRF docs
specify roughly 11 dB. Receiver and gain controls are disabled while adjusting;
**Cancel** keeps the gains already applied.

This optimizes ADC level, not station SNR or antenna matching. Strong signals
anywhere in the sampled band can limit gain, and analog overload before the ADC
may not be detected. Reduce bandwidth or try manual gains if reception suffers.

---

## 💻 Build Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server (http://localhost:5173) |
| `npm run build` | Build client assets into `dist/` |
| `npm run build:mbelib` | Rebuild the DSD voice codec (requires Emscripten; optional for normal builds) |
| `npm run deploy` | Build and deploy to Cloudflare Workers |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run test` | Run tests with Vitest |

### Building the WASM Module

The Rust/WASM module must be built separately (requires Rust toolchain):

```bash
cd hackrf-web
cargo make build       # Build for web (output: hackrf-web/pkg/)
```

> **Note:** The WASM build outputs in `hackrf-web/pkg/` are committed to the repo, so `npm run deploy` works seamlessly even without Rust installed on the CI/deployment machine.

---

## 🎧 Running the App

1. Connect a supported SDR to a USB port and complete any required USB driver setup.
2. Open the application and click **Connect Device**.
3. Select your SDR from the device picker; pair a new device through the browser's USB prompt if needed.
4. Set your desired **Center Frequency** and hit **Play**.
5. Click anywhere on the spectrum or waterfall to instantly tune a new VFO, or manually add as many VFOs as you want!
6. Customize the demodulation mode (WFM, NFM, AM, USB, etc.) and DSP settings for each VFO.
7. Adjust the device-specific gain and antenna controls for optimal signal reception.

---

## 🧪 Testing

```bash
# TypeScript / Worker tests
npm run test

# Rust / WASM tests
cd hackrf-web
cargo make test
```

---

## 📜 License

Licensed under the **AGPL-3.0** — see [LICENSE](LICENSE) for details.
