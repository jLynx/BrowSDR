# MAC vendor database source

`macaddress.db` is an unmodified snapshot from PortaPack Mayhem:

- Repository: https://github.com/portapack-mayhem/mayhem-firmware
- Commit: `6ea6de6582e0c1cb43aa3d73194505d75bf11f85`
- File: `sdcard/MACADDRESS/macaddress.db`
- SHA-256: `2068b5f15b782d90daa00505d0af4a7939591219d8dd6050aabe9dbe60da3750`
- Allocation data: https://standards-oui.ieee.org/oui/oui.txt

PortaPack's `firmware/tools/make_macaddress_db/make_macaddress_db.py` generates
this database from IEEE OUI allocations, normalizing vendor names to ASCII.
The format stores sorted seven-byte OUI keys (six hex characters and a NUL)
followed by the corresponding 64-byte, NUL-padded vendor names.

The generator is credited to Tommaso Ventafridda (2025) and licensed under
GPL-2.0-or-later. BrowSDR's loader is independently implemented; the upstream
generator and firmware code are not included. Vendor names describe the OUI
allocation holder, rather than a guaranteed product manufacturer or model.

Rebuild with `npm run build:ble-db`; its manifest records the source commit,
content hash, byte length and record count. Update this notice when changing the
pinned snapshot.
