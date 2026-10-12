# Planned features

Requested features for future BrowSDR development. Unchecked items are not yet
implemented; the list does not set priorities or release dates.

- [ ] **Radiosonde decoding** — Decode weather balloon telemetry, including position and weather measurements.
- [x] **ACARS (initial VHF support)** — Decode aircraft operational messages (Aircraft Communications Addressing and Reporting System), with a searchable message list. See the [reception guide](acars.md) for scope and limitations.
- [ ] **APRS** — Decode amateur radio position reports, messages, and telemetry (Automatic Packet Reporting System).
- [x] **AIS (initial Class A/B support)** — Decode vessel identification, position and movement reports on both AIS channels, with a live map and ITU MID country lookup. See the [reception guide](ais.md) for scope and limitations.
- [x] **ADS-B (initial 1090ES support)** — Decode aircraft identification, airborne position, altitude, and ground velocity, with a live map. See the [reception guide](adsb.md) for scope and limitations.
- [x] **BLE (initial legacy LE 1M support)** — Passively decode nearby advertisements with fixed-channel listening or three-channel scanning and a live device list. See the [reception guide](ble.md) for hardware requirements and limitations.
