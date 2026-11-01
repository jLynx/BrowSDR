# Mammotion RTK models and BrowSDR profiles

Research updated 1 November 2026. This reference records verified mappings and remaining unknowns; it does not change
decoder behavior or UI labels. Individual station serials, cloud device IDs and LoRa pairing/address values are omitted.
Catalogue model IDs and product keys below identify shared product models, not individual stations.

## BrowSDR profile and hardware names

BrowSDR's `rtk1`, `rtk2` and `rtk3` keys select radio decoders. They are not Mammotion catalogue model IDs. A detected
protocol alone does not establish the exact enclosure model.

| BrowSDR profile | Hardware association                                                                             | App/catalogue name                                            | Finding                                                                                                                   | Suggested descriptive label |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `rtk1` / RTK1   | Original, first-released Mammotion RTK station                                                   | No mapping established in the connected-app catalogue         | Hardware history confirmed by the owner: no Wi-Fi or Bluetooth. Its radio wrapper is supported.                           | Original RTK station · RTK1 |
| `rtk2` / RTK2   | Second-released station supplied with Luba 2                                                     | `RtkRefStationV1` / `HMRTKV1`                                 | Association confirmed by the owner and authenticated catalogue/product-key lookup. Keep the RTK2 numbering.               | Reference Station · RTK2    |
| `rtk3` / RTK3   | RBS03-format radio traffic; reference protocol documented from an RBS03 base used with Luba mini | RBS03-related catalogue lists `RTK300`, `RTK310` and `RTK301` | Decoder verified against recorded IQ. Exact model-to-profile compatibility for each catalogue variant remains unverified. | RBS03 family · RTK3         |

`V1` in `RtkRefStationV1` must not be interpreted as the first-ever Mammotion RTK release. The connected Reference Station
is BrowSDR's RTK2 in the confirmed hardware history. The reason Mammotion chose the `V1` suffix is not established.

The suggested labels are recommendations, not implemented renames. For automatically discovered sources, describe the
detected **protocol** as RTK1, RTK2-compatible or RBS03/RTK3-compatible. Show an exact hardware model separately only when
reported metadata or a confirmed association supports it. Do not rename RTK3 to RTK310 on the current evidence.

## Station-name prefixes in the app

Mammotion 2.3.28.25 (version code 352) contains `DeviceType.valueOfStrByDeviceName`, which recognizes these families.
`DeviceType.valueOfStr` additionally uses product keys. These internal families are distinct from catalogue display labels.

| Station-name prefix | App `DeviceType` | Internal model code | Exact display-model mapping                                                                                                                                                                                                                      |
| ------------------- | ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RTK…`              | `RTK`            | `RTK`               | Connected Reference Station association with `RtkRefStationV1` is confirmed through its product key. No universal subtype-decoding rule from the serial suffix was established. This app enum must not be confused with BrowSDR's original RTK1. |
| `RBSA0…`            | `RTK3A0`         | `RBS03A0`           | Prefix-to-family mapping is verified. Its individual correspondence to `RTK300`, `RTK310` or `RTK301` is unresolved.                                                                                                                             |
| `RBSA1…`            | `RTK3A1`         | `RBS03A1`           | Prefix-to-family mapping is verified. Its individual correspondence to `RTK300`, `RTK310` or `RTK301` is unresolved.                                                                                                                             |
| `RBSA2…`            | `RTK3A2`         | `RBS03A2`           | Prefix-to-family mapping is verified. Its individual correspondence to `RTK300`, `RTK310` or `RTK301` is unresolved.                                                                                                                             |
| `NB…`               | `RTKNB`          | `NB`                | App family verified; related catalogue product keys identify `NRTK`. No BrowSDR radio-profile assignment is established here.                                                                                                                    |

The app also has helpers named `isRTK2_()` for `RTK3A2` and `isRTK3_()` for `RTK3A1`. Its naming is not a consistent global
hardware-generation scheme; those helper names do not prove an exact catalogue label or BrowSDR protocol assignment.

## Authenticated product catalogue

The successful catalogue fetch on 1 November 2026 returned the following model entries, agreeing with the earlier public
PyMammotion fixture. Preserve the exact case of labels and product keys.

| Display label (`extMod`) | Internal catalogue model (`intMod`) | Catalogue model ID (`intId`) | Shared product keys          | BrowSDR mapping status                                                                                                               |
| ------------------------ | ----------------------------------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `RtkRefStationV1`        | `HMRTKV1`                           | `16`                         | `a1Nc68bGZzX`, `mUzerUySdcC` | Confirmed association with the connected Luba 2-era Reference Station, known here as RTK2. Each listed key has one catalogue model.  |
| `RTK300`                 | `RTK300`                            | `96`                         | `a1wIIUUdAMX`, `sePx2YW6xDT` | Same product-key family as RTK310/RTK301. Individual serial-prefix and radio-profile correspondence unverified.                      |
| `RTK310`                 | `RTK310`                            | `95`                         | `a1wIIUUdAMX`, `sePx2YW6xDT` | Exact catalogue spelling is uppercase `RTK310`, not `Rtk310`. Individual serial-prefix and radio-profile correspondence unverified.  |
| `RTK301`                 | `RTK301`                            | `94`                         | `a1wIIUUdAMX`, `sePx2YW6xDT` | Same product-key family as RTK300/RTK310. Individual serial-prefix and radio-profile correspondence unverified.                      |
| `SolarRtkV2`             | `HMRTKV2`                           | `97`                         | `a1vIxwrmpMn`, `HwHcWDDVkT9` | Additional catalogue model. Do not assign it to RTK2 solely because its name contains V2; supported radio format is unverified here. |
| `NRTK`                   | `NRTK`                              | `54`                         | `a1NfZqdSREf`, `6DPytKe4pKz` | Additional catalogue model related to the app's RTKNB family. No existing LoRa decoder assignment established.                       |

FCC listings supplied during the investigation included `RTK`, `RTK0002`, `RTK300` and `RTK310`. A complete mapping between FCC names, app models and BrowSDR profiles is not verified; specifically, no catalogue mapping for `RTK0002` was established. Different catalogue
models do not automatically require different decoder profiles.

## How the app chooses its display model

| Stage                                  | Function/data                                                                               | Result                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Recognize a name                       | `DeviceType.valueOfStrByDeviceName`; `valueOfStr` can also use the product key              | Internal family such as `RTK3A0`, not an exact RTK310 label                                               |
| Obtain model data                      | Device/cloud properties or the `SYS_DEVICE_PRODUCT_TYPE_INFO` response                      | Saved `productType` and `subProductType`; the subtype is reported model data, not a decoded serial suffix |
| Cache product catalogue                | GET `/device-server/v1/product/product/list`; cached as `device_outer_code`                 | Product keys with `productModelVos` entries containing `intId`, `intMod` and `extMod`                     |
| Choose display label                   | `DeviceUtils.getDeviceExtModName` matches saved `subProductType` to `intId` **or** `intMod` | Returns the matching `extMod`, preserving its case                                                        |
| Resolve a single-model key in research | Match a known station product key to a catalogue key with one model entry                   | Can establish the model without a returned subtype; a multi-model key needs additional model evidence     |

The last row describes the research lookup, not the app's own subtype-selection function. A serial-only converter can
reliably return the verified prefix family. It cannot currently choose RTK300/RTK310/RTK301 for an arbitrary RBSA name.

BrowSDR's current station headings derive their RTK generation text from the decoder profile. Their receiver name can come
from RTCM equipment metadata, which may identify the GNSS receiver module rather than the RTK enclosure. Neither field
currently performs the app's catalogue lookup.

## Evidence and further verification

| Source                                                                                                                                                          | What it establishes                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Owner-confirmed hardware history                                                                                                                                | Original station lacks Wi-Fi/Bluetooth; the second station supplied with Luba 2 is called RTK2 in BrowSDR     |
| Recovered Mammotion 2.3.28.25 Java source                                                                                                                       | Prefix-family function, product-key families, subtype persistence and catalogue display-label selection       |
| Authenticated Mammotion product catalogue                                                                                                                       | Exact model labels, model IDs and shared keys in the catalogue table; connected Reference Station association |
| [Public PyMammotion catalogue fixture](https://github.com/mikey0000/PyMammotion/blob/c2ed6544319be0525e0fdbb09ed227aebfd3434a/tests/fixtures/product_list.json) | Independent published reference containing the same catalogue model entries                                   |
| [VE2MRX RBS03 protocol reference](https://github.com/Ve2mrx/mammotion-rtk-lora/blob/7cb61c36187c4becd408a99be4f0050d416e65bf/PROTOCOL.md)                       | RBS03-format protocol basis for BrowSDR's RTK3 decoder                                                        |
| [BrowSDR RTK guide](../../../../../../docs/rtk.md), [profile definitions](profiles.ts) and [station headings](../../../../app/decoders/rtk/stations.ts)         | Implemented decoder behavior, recorded-IQ verification and current UI identification limits                   |

To complete the RBSA crosswalk, collect each variant's reported `subProductType` together with its catalogue model, then
verify the corresponding RF format against captured traffic. Until then, retain the three existing decoder profile keys
and keep exact hardware-model claims separate from protocol detection.
