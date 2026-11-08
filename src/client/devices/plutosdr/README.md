# PlutoSDR

BrowSDR talks to the PlutoSDR's **IIO** USB interface with libiio's protocol; the network, storage and serial interfaces stay with the operating system. ADALM-PLUTO and firmware clones that expose `ad9361-phy` and `cf-ad9361-lpc` should work.

- **Windows:** install **WinUSB** on the **IIO** interface only with [Zadig](https://zadig.akeo.ie/): enable _List All Devices_ and pick the PlutoSDR entry named _IIO_ or ending in _Interface 5_.
- **Linux:** install the [PlutoSDR udev rules](https://github.com/analogdevicesinc/plutosdr-fw/blob/master/scripts/53-adi-plutosdr-usb.rules) so the browser can open the device without root.
- **Sample rates:** 2.4–6 MSPS. Each sample takes 4 bytes over USB 2.0, which limits continuous reception.
- **Tuning range:** whatever the firmware reports, typically 325–3800 MHz, or 70–6000 MHz on firmware switched to AD9364 mode. A new connection starts inside that range.
- **Gain:** **Gain Mode** selects manual gain or an AD936x AGC mode; **RF** gain applies in manual mode, limited to the current band's range.
- **Dropped samples:** IIO has no sample counters, so the received rate is compared with the configured one every 10 seconds, and a shortfall is logged as a browser console warning.
