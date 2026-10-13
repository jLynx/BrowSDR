# Radiosonde balloon reception

Open **Tools → Radiosonde**, select a VFO, choose **Tune 403.000 MHz**, then
enable **Decode VFO**. Other balloon frequencies can be tuned manually within
400–406 MHz. Start reception with an SDR and antenna covering that frequency.
The decoder has an independent 48 kHz IQ channel; speaker audio can stay muted,
and closing the panel keeps decoding enabled. LimeSDR reception can use 5 MS/s.
The selected antenna input must match the physical connection.

The initial decoder supports Vaisala **RS41** 4800-baud FSK, both signal
polarities, standard 320-byte and extended 518-byte frames, dewhitening and
CRC-checked identity, GPS and combined GNSS position/time blocks. It shows sonde ID, frame number, battery,
GPS coordinates and altitude in metres, ground speed and climb in metres per
second, course, satellites, and GPS UTC/local time when transmitted. It also
collects per-sonde calibration fragments for external temperature, humidity,
humidity-sensor temperature, dew point and measured pressure when the sonde
has a pressure sensor. Standard-atmosphere pressure derived from altitude is
labelled as an estimate and used for humidity compensation on SG variants.
Encrypted RS41-SGM and other sonde models remain unsupported. Unknown values
appear as a dash; weather age is shown so an older reading is identifiable.

Balloon details include maximum altitude received during this session, exact
sonde subtype, PCB version/serial, firmware, transmitted frequency, TX power
level, reference temperature, flight phase, burst/flight timers and countdown,
heater PWM, flags, GPS quality and calibration progress. The expanded
configuration section shows transmitted battery thresholds/capacity, launch
settings, internal temperatures, resets and GPS error counters. Satellite
measurements and XDATA instrument payloads have their own expandable sections.
Raw dewhitened blocks, CRC status, sensor counts and collected calibration
fragments remain available for inspection, including undocumented payloads.
The full calibration checksum is reported when all constant fragments arrive.
Individual weather fields require all fragments used by their calculation;
weak reception can take longer than the normal 51-second calibration cycle.
SondeHub's receiving-station list is network metadata and is not transmitted
by the balloon.

Reed–Solomon correction repairs up to twelve damaged bytes in each of the two
interleaved codewords. Both corrected words must pass their syndrome checks,
and identity and GPS blocks still require valid CRCs before being displayed.

Select a balloon to focus its map marker and open telemetry details. The map
has balloon icons, bounded trails, fit controls and fullscreen with Escape to
exit. CRC-invalid GPS blocks never refresh an earlier fix. Positions expire
after five minutes; balloons expire after thirty minutes. Up to 32 balloons
and 300 trail positions per balloon are retained. The list and decoding work
without internet; OpenStreetMap tiles need internet for uncached areas.

Local and remote receivers route telemetry for the configured VFO, including
muted VFOs. Retuning, stopping and removing a VFO discard its stale messages;
IQ delivery gaps clear partial frames. Settings and bookmarks retain the decoder
flag. Sync counts measure candidate headers across symbol phases; they are not
counts of unique validated radio frames.

Tests cover synthetic FSK, both polarities, frame lengths, chunk boundaries,
CRC corruption, position expiry, UI controls, and the production WASM
channelizer at 1 and 5 MS/s. Synthetic fixtures establish those behaviors;
recorded and live reception checks are described below.

Two upstream FM audio recordings were also replayed through the production IQ
demodulator on 13 October 2026. The 2014 recording produced 120 unique
CRC-valid frames for **K1930308** with GPS positions; the 2015 recording produced
60 for **L1830070** with GPS positions. GPS-to-UTC conversion accounts for their
historical leap-second offsets. This is recorded reception verification.
Both recordings also assembled all 51 calibration fragments with a valid
checksum and produced calibrated temperature and humidity. The final 2014
sample measured **−40.67°C** and **0.38% RH**; the 2015 sample measured
**−51.47°C** and **1.06% RH**. Both identified **RS41-SG / RSM412** hardware.
Legacy satellite blocks expose signal/quality codes, pseudorange and raw
Doppler. The newer GNSS satellite layout is retained as raw data because its
status meanings are not fully established.

To reproduce it, download the mono 48 kHz WAV files from
[the reference recordings](https://github.com/rs1729/RS/tree/master/rs41/wav)
into `.cache/radiosonde/`, then run:

```sh
node scripts/radiosonde/check-recording.mjs .cache/radiosonde/20140717_402MHz.wav .cache/radiosonde/rs41pre_20150802.wav
```

The check reports deduplicated CRC-valid frame counts and the last received
telemetry, and fails if no valid identity and GPS position are recovered.
Recordings remain local test inputs and are not redistributed with the app.

Live verification succeeded on 13 October 2026 around 12:32 pm NZDT using
the connected **HackRF One** at 5 MS/s. The VFO remained at **403.000 MHz**,
with the receiver centered at **402.800 MHz** to move the DC artifact out of
the channel, LNA/VGA gains at 32 dB and the 14 dB amplifier enabled. The app
received CRC-valid frames for **Y1672968**, displayed a GPS position near
**-36.84585, 174.71098**, altitude **9,047 m**, climb **6.0 m/s** and
**10 satellites**, and plotted the balloon and its trail. The initial LimeSDR
test did not produce valid frames; live success was established with HackRF.

Protocol reference: [RS41 radio format and decoder](https://github.com/rs1729/RS/tree/master/demod/mod).
Calibration layout and metrology references:
[ra-firmware RS41](https://github.com/einergehtnochrein/ra-firmware/tree/master/src/rs41)
and [RS41 calibration field reference](https://github.com/projecthorus/radiosonde_auto_rx/blob/master/auto_rx/utils/rs41cal.py).
