# BLE reception

BrowSDR passively receives Bluetooth Low Energy **legacy LE 1M advertisements**.
Open **BLE Devices** from the tools menu after connecting a receiver. Use a
HackRF or LimeSDR with a 2.4 GHz antenna and a sample rate of at least 2 MSPS
(4–8 MSPS is a useful starting point). RTL-SDR and Airspy receivers cannot
directly tune this band; an appropriate external frequency converter and
frequency shift are needed to use them here.

Select a VFO and choose **Scan all channels**. The scanner mutes that VFO and
cycles the receiver through the advertising channels, listening for one second
on each after tuning:

| Channel | Frequency |
| ------- | --------- |
| 37      | 2402 MHz  |
| 38      | 2426 MHz  |
| 39      | 2480 MHz  |

**Stop scan** stops cycling and disables decoding on the scanning VFO. The radio
stays on its last channel. Closing the panel keeps scanning/decoding running.
Stopping reception or disconnecting stops the scanner. Manual retuning, removal
of its VFO, and automatic gain adjustment also stop cycling. Frequency locks for
remote clients do not prevent the local receiver owner from tuning or scanning.

For fixed reception, use **Tune 37/38/39**, then **Decode selected VFO**. Decoding
works with the speaker muted. Remote clients can enable fixed-channel decoding
when the host is already tuned appropriately; automatic scanning is controlled
on the host.

Tuning or scanning retunes the **whole receiver**, affecting every VFO and remote
listener on it. A VFO cannot receive a channel outside the hardware's current
capture. The three advertising channels span 78 MHz; a complete simultaneous
capture needs about 80 MHz of usable bandwidth, beyond the maximum sample rate
of our current receivers. Portapack Mayhem's BLE Auto mode likewise cycles these
three channels with a single receiver. Multiple receivers can each listen to a
fixed channel; each has its own device list. A single channel often detects many
devices because legacy advertisers commonly repeat on all three channels.

The list merges advertisements and overheard scan responses by address and
public/random address type. It shows advertised names, MAC vendor names for
public addresses, a small BLE manufacturer ID lookup (unknown IDs stay numeric),
service UUIDs, raw manufacturer/service data,
advertised TX power, observed channels, packet count, signal level and time since
last seen. Only CRC-verified packets enter the list. Entries expire after five
minutes, and the list retains at most 500 addresses. Clear devices starts a new
list without interrupting reception.

## Vendor database

MAC vendors use the same binary `macaddress.db` as PortaPack Mayhem, generated
from IEEE's OUI allocations. This identifies the organization assigned the first
three bytes of a **public** MAC address. It does not identify a device model.
Random/private addresses show **Random address**, without a vendor assignment.
The separate **BLE manufacturer** comes from the company ID in advertising data;
it can differ from the MAC vendor and remains available for random addresses.
Search matches both vendor and manufacturer names.

The browser loads `ble-db/manifest.json` and `ble-db/macaddress.db` from the shared
database host, then tries the bundled snapshot, then the last verified browser
cache. Downloads are checked for length, SHA-256 and valid sorted records before
use or caching. Browser storage is optional and can be evicted; a missing database
does not stop reception. The bundled snapshot contains 37,523 records (2.66 MB).
Device observations remain in memory and are not written to this database.

`npm run build:ble-db` refreshes the bundled files from a pinned upstream commit.
To select a reviewed update, run `npm run build:ble-db -- --commit <full SHA>`.
`npm run publish:ble-db` uploads the verified snapshot to the shared database host
using the existing `DATABASES_BUCKET` and `DATABASES_PUBLIC_URL` settings. The
BLE database is refreshed manually; the aircraft/MID scheduled jobs are unchanged.
See [shared database storage](databases.md) and the bundled
[source notice](../public/ble-db/NOTICE.md).

## Scope and limitations

- Supported PDUs: ADV_IND, ADV_DIRECT_IND, ADV_NONCONN_IND, ADV_SCAN_IND and
  SCAN_RSP on the primary advertising channels, at 1 Mbit/s.
- This is passive reception: BrowSDR sends no scan requests or connections.
  Some names are only provided in responses to other scanners and may be absent.
- Extended advertising, secondary advertising channels, LE 2M, LE Coded,
  Bluetooth Classic, connection traffic and encrypted payloads are not decoded.
- Random/private addresses can rotate. Several entries can belong to one device;
  an address is not a stable physical identity. Quiet, connected or unsupported
  devices may not appear. Cycling necessarily misses packets on other channels.
- Signal is measured in relative **dBFS**, not calibrated RSSI in dBm and not
  distance. Receiver gains, bandwidth and interference affect it.
- Generated Gaussian BLE IQ has been tested through the production DSP worker
  using byte and float inputs, with channel shifts, packet splitting and corrupt
  packets. Live hardware reception and USB retuning still need field validation.
