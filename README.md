# 📻 [BrowSDR](https://browsdr.jlynx.net)

[![BrowSDR Live](https://img.shields.io/badge/Live-browsdr.jlynx.net-success?style=for-the-badge&logo=cloudflare)](https://browsdr.jlynx.net)
[![Rust](https://img.shields.io/badge/Rust-High%20Performance-orange?style=for-the-badge&logo=rust)](https://www.rust-lang.org/)
[![WebAssembly](https://img.shields.io/badge/Wasm-Powered-blue?style=for-the-badge&logo=webassembly)](https://webassembly.org/)
[![Discord](https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/m8BtU4ebSH)

A blazing fast, next-generation browser-based Software Defined Radio (SDR) receiver for HackRF, HackRF Pro, RTL-SDR, Airspy, LimeSDR, and PlutoSDR devices. Connect a compatible SDR directly to your browser via WebUSB and tune into FM, AM, SSB, CW, and more — **no drivers, no native software, no hassle.**

---

## ✨ Features

Enjoy the power of a desktop SDR platform fully within your web browser.

- **🎯 Multi-VFO Mastery**
  Tune into multiple frequencies simultaneously! Create an unlimited number of Virtual Frequency Oscillators (VFOs), each with independent demodulation, volume, squelch, and DSP settings. Listen to multiple broadcasts without dropping a single packet.
- **⚡ High-Speed Rust & WASM Architecture**
  Built for raw performance. FFT and DSP pipelines are written in **Rust** and compiled to **WebAssembly (WASM)**. Running inside Web Workers off the main thread ensures a crystal-clear, smooth UI and buttery 60 FPS performance, even with multiple active VFOs.
- **🎙️ Live Transcribe**
  Built-in AI-powered live transcription of demodulated audio right in your browser.
- **📟 POCSAG Decoder**
  Instantly decode paging networks straight from the UI.
- **🌡️ rtl_433 Sensor Decoder**
  Live browser-side OOK/FSK decoding for supported weather sensors, remotes, TPMS,
  and other ISM devices. See
  [the decoder build and reception guide](wasm/rtl433/README.md).
- **✈️ ADS-B Aircraft and Live Map**
  Decode 1090 MHz aircraft transmissions locally, with callsigns, altitude,
  ground speed, and live positions on an interactive map.
- **🚢 AIS Vessels and Live Map**
  Decode Class A/B vessel transmissions on AIS A and AIS B, with vessel details, live positions, and ITU MID country lookup.
- **🎈 Radiosonde Balloons and Live Map**
  Decode Vaisala RS41 balloon GPS telemetry with altitude, movement, battery.
- **🔵 BLE Devices**
  Passively discover nearby BLE advertisements with channel scanning, advertised
  names, service UUIDs and a live device list.
- **✉️ ACARS Aircraft Messages**
  Decode VHF aircraft operational messages with registration, flight, label and
  searchable text.
- **📍 APRS Stations and Live Map**
  Decode amateur radio position reports, messages, weather and telemetry on
  1200-baud packet channels, with a live station map.
- **📊 Frequency Activity**
  Visually spot active signals and quickly jump to transmissions using the dynamic frequency activity scanner and interactive waterfall display.
- **🔖 Advanced Bookmarking System**
  Save, organize, and quickly recall your favorite frequencies. Group your bookmarks into custom categories to effortlessly manage airbands, ham frequencies, repeaters, or emergency services.
- **🌊 Real-time WebGL Waterfall & Spectrum**
  Monitor the entire RF band visually with an ultra-responsive, GPU-accelerated waterfall and spectrum analyzer.
  Waterfall scrolling and spectrum smoothing are time-based: higher FPS makes animation smoother without speeding up the history. The 512-row waterfall retains approximately 25.6 seconds of continuous reception at every target.
- **📻 Wide Demodulation Support**
  Supports WFM, NFM, AM, USB, LSB, DSB, CW, and raw IQ modes.
- **📡 RDS Decoding on the Fly**
  Instantly decode station name, programme type, and radiotext on WFM signals.
- **🎛️ Full DSP Toolset**
  Control squelch, noise reduction, de-emphasis, and stereo output per VFO.
- **🌐 Remote Access**
  Share all connected SDRs with others through one WebRTC link using PeerJS. Each remote user has independent VFOs on every receiver.
- **📡 Multiple SDRs at Once**
  Connect any number of compatible SDRs, including mixed device families. Each receiver has independent tuning, sample rate, gains, waterfall, and VFOs. Switch receiver tabs while audio from all enabled VFOs continues playing.
  Device settings stay in separate saved slots when USB serial numbers collide. WebUSB cannot distinguish identical devices across reloads if their enumeration order changes; assign unique serial numbers when possible for reliable physical-device matching.

---

## 🗓️ Planned Features

See the [feature roadmap](docs/roadmap.md) for requested additional radiosonde
support, alongside completed APRS, ACARS, AIS, ADS-B and initial BLE features.

---

## 🚀 How It Works

1. **WebUSB** — Communicates directly with your supported SDR device from Google Chrome or Edge.
2. **WebAssembly** — Signal processing (FFT, filtering, decimation, mixer, demodulation) is handled by [RustFFT](https://github.com/awelkie/RustFFT) and highly optimized Rust code compiled to WASM.
3. **Web Workers** — Multi-threaded DSP via [Comlink](https://github.com/GoogleChromeLabs/comlink) keeps the event loop entirely free of blocking tasks.
4. **WebGL** — Hardware-accelerated FFT rendering.
5. **Vue 3** — A sleek, reactive UI powering complex per-VFO controls.
6. **Cloudflare Workers** — Fast edge-deployed static assets and API proxy.

_(Note: WebUSB requires a secure context — HTTPS or `localhost`)_

---

## 📡 Supported Devices

BrowSDR includes receive drivers for the following device families. Driver availability does not mean every model, firmware version, or feature has been hardware-tested.

| Device family  | Models / variants                                                       | Notes                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HackRF**     | HackRF One, HackRF Pro                                                  | Uses the HackRF WebUSB driver; compatible devices using the same protocol and recognized USB IDs may also work.                                                                                       |
| **RTL-SDR**    | RTL-SDR Blog V3 and V4, compatible Nooelec and generic RTL2832U dongles | Supports R820T, R820T2, R828D, E4000, FC0012, FC0013, and FC2580 tuners. Includes Blog V4-specific tuner configuration. Compatibility depends on the tuner and recognized USB ID, not just the brand. |
| **Airspy**     | Airspy One, R2, Mini                                                    | Includes an Airspy receive driver with device-reported sample rates.                                                                                                                                  |
| **Airspy HF+** | Airspy HF+ family                                                       | Includes a separate HF+ receive driver; individual variants still require hardware verification.                                                                                                      |
| **LimeSDR**    | LimeSDR-USB                                                             | Uses the LimeSDR WebUSB receive driver with gain and antenna controls. See the Windows setup below.                                                                                                   |
| **PlutoSDR**   | ADALM-PLUTO and Pluto firmware clones using USB ID `0456:b673`          | Speaks libiio's IIO-over-USB protocol to the firmware's iiod; 2.4–6 MSPS with manual or AGC gain. Not yet hardware-tested. See the PlutoSDR notes below.                                              |

Use a WebUSB-capable browser such as Chrome or Edge, over HTTPS or `localhost`. On Windows, the SDR's USB interface may need **WinUSB** instead of a vendor or DVB-T driver. Close other applications using the device before connecting.

---

## 🧰 Tech Stack

| Layer      | Technology                                                 |
| ---------- | ---------------------------------------------------------- |
| Frontend   | TypeScript, Vue 3 (Options API), Vite                      |
| UI catalog | Storybook, shared Vue UI components                        |
| DSP        | Rust, RustFFT, WebAssembly, Web Workers                    |
| Deployment | Cloudflare Workers (Wrangler)                              |
| Testing    | Vitest, wasm-bindgen-test, cargo test                      |
| UI testing | Vue Test Utils, jsdom, Storybook browser interaction tests |

---

## 🛠️ Prerequisites

| Tool                                                    | Purpose                           | Install                                                           |
| ------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| [Node.js](https://nodejs.org/)                          | Build & dev server                | Download from website                                             |
| [Rust](https://rustup.rs/)                              | Compile WASM module               | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| `wasm32-unknown-unknown` target                         | Rust → WASM                       | `rustup target add wasm32-unknown-unknown`                        |
| [wasm-pack](https://rustwasm.github.io/wasm-pack/)      | Build & package WASM              | `cargo install wasm-pack`                                         |
| [cargo-make](https://github.com/sagiegurari/cargo-make) | Task runner for Rust builds       | `cargo install --force cargo-make`                                |
| A WebUSB-capable browser                                | Run the app (e.g., Google Chrome) | —                                                                 |

---

## ⚙️ Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Build the WASM module (first time or after Rust changes)
npm run build:dsp

# 3. Start the local dev server
npm run dev
```

Then open **[http://localhost:5173](http://localhost:5173)** in Google Chrome or any WebUSB-supported browser.

### Shared UI and Storybook

Run `npm run storybook` to browse existing component variants at
[http://localhost:6006](http://localhost:6006). The app and Storybook use the same
stylesheet. See the [UI component guide](src/client/ui/README.md) for component
contracts, examples, tests, and how to add future features.

Run `npm run test:ui` for component tests. After `npx playwright install chromium`,
run `npm run test:storybook` to render the catalog and check story interactions.
`npm run build:storybook` creates a standalone catalog in `storybook-static/`.

### LimeSDR-USB on Windows

WebUSB requires the LimeSDR-USB to use **WinUSB**, rather than the native Cypress **CYUSB3** driver. If connecting fails with **Access denied**, check the driver for the LimeSDR in Device Manager and close other SDR applications or browser tabs using it.

Use Device Manager to select an already-installed WinUSB driver, or install one for **LimeSDR-USB only** using [Zadig](https://zadig.akeo.ie/). Do not replace drivers for USB hubs or unrelated devices. Reconnect the device and select it again in Chrome or Edge after changing the driver.

Changing to WinUSB can affect native SDR applications that require CYUSB3; switch back to the previous driver when those applications need it. See [Chrome's Windows WebUSB requirements](https://developer.chrome.com/docs/capabilities/build-for-webusb#windows).

LimeSDR-USB reception supports sample rates up to **61.44 MSPS**.

Choose **RX1** or **RX2** using **RX Channel** in the Radio panel, then select **LNAH**, **LNAL**, or **LNAW** under **Antenna** to match the H, L, or W connector in that receiver's antenna group. One receiver is streamed at a time; switching briefly restarts reception while retaining the current frequency, gains, and antenna path. The receiver and antenna selections are saved locally.

### PlutoSDR

BrowSDR talks to the PlutoSDR's own **IIO** USB interface, the one libiio uses; the network, storage and serial interfaces stay with the operating system. It controls `ad9361-phy` and streams `cf-ad9361-lpc`, so Pluto firmware clones with the same IIO devices should also work.

- **Sample rates:** 2.4–6 MSPS; each sample takes 4 bytes over USB 2.0, which limits continuous reception to about 6 MSPS. The AD936x's 12-bit samples are kept in 16-bit containers unless a lower **IQ Precision** is selected. A programmable FIR left enabled by other software is turned off, since these rates do not need it.
- **Dropped samples:** IIO buffers carry no sample counters, so BrowSDR compares the received rate with the configured one every 10 seconds. A shortfall is logged as a browser console warning; development builds also log each measurement.
- **Tuning range:** whatever the firmware reports, typically 325–3800 MHz, or 70–6000 MHz on firmware switched to AD9364 mode.
- **Gain:** **Gain Mode** selects manual gain or one of the AD936x AGC modes; **RF Gain** applies in manual mode and is limited to the range for the current band.
- **Linux:** install the [PlutoSDR udev rules](https://github.com/analogdevicesinc/plutosdr-fw/blob/master/scripts/53-adi-plutosdr-usb.rules) so the browser can open the device without root.
- **Windows:** Chrome needs **WinUSB** on the Pluto's **IIO** interface. If connecting fails with **Access denied**, install WinUSB for that interface only with [Zadig](https://zadig.akeo.ie/) (enable _List All Devices_ and pick the PlutoSDR entry ending in _Interface 5_ or named _IIO_).

### IQ precision and recording size

Reception retains each driver's native sample precision: HackRF and RTL-SDR use
8-bit IQ, LimeSDR, Airspy and PlutoSDR retain their 12-bit sources in 16-bit containers, and
Airspy HF+ retains its delivered 16-bit samples. Stop reception to select a lower
**IQ Precision** under **Radio → Advanced** on higher-resolution radios. This
reduces sample detail and internal memory traffic. LimeSDR's separate **USB Format**
controls wire packing; reducing IQ precision alone does not reduce USB traffic.

**Tools → IQ Recorder** offers 8-bit, 16-bit, and normalized 32-bit float recording
on higher-precision reception. 12-bit samples use 16-bit file storage; choosing
8-bit halves that file size. See [IQ recording](docs/iq-recording.md) and
[IQ replay](docs/iq-replay.md).

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

| Command                | Description                                                                   |
| ---------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`          | Start Vite dev server (http://localhost:5173)                                 |
| `npm run build`        | Build client assets into `dist/`                                              |
| `npm run build:mbelib` | Rebuild the DSD voice codec (requires Emscripten; optional for normal builds) |
| `npm run deploy`       | Build and deploy to Cloudflare Workers                                        |
| `npm run typecheck`    | Run TypeScript type checking                                                  |
| `npm run test`         | Run tests with Vitest                                                         |

### Building the WASM Module

The Rust/WASM module must be built separately (requires Rust toolchain):

```bash
cd wasm/dsp
cargo make build       # Build for web (output: wasm/dsp/pkg/)
```

> **Note:** The WASM build outputs in `wasm/dsp/pkg/` are committed to the repo, so `npm run deploy` works seamlessly even without Rust installed on the CI/deployment machine.

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

# Code checks and native Rust DSP tests (requires Rust/Cargo)
npm run check

# Native Rust DSP tests only
npm run test:dsp

# Rust / WASM tests
cd wasm/dsp
cargo make test
```

---

## 💬 Community

Join the [BrowSDR Discord community](https://discord.gg/m8BtU4ebSH)
for setup help, hardware and antenna discussions, sharing receptions,
and development chat.

---

## 📜 License

Licensed under the **AGPL-3.0** — see [LICENSE](LICENSE) for details.
