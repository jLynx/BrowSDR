# LimeSDR-USB

- **Windows:** WebUSB requires **WinUSB** rather than the native Cypress **CYUSB3** driver. Select an already-installed WinUSB driver in Device Manager, or install one for **LimeSDR-USB only** using [Zadig](https://zadig.akeo.ie/). Reconnect the device and select it again in Chrome or Edge after changing the driver. Native SDR applications that require CYUSB3 need the previous driver back. If connecting still fails with **Access denied**, close other SDR applications or browser tabs using the device.
- **Sample rates:** up to **61.44 MSPS**.
- **Receivers and antennas:** choose **RX1** or **RX2** using **RX Channel** in the Radio panel, then select **LNAH**, **LNAL**, or **LNAW** under **Antenna** to match the H, L, or W connector in that receiver's antenna group. One receiver is streamed at a time; switching briefly restarts reception while retaining the current frequency, gains, and antenna path. The receiver and antenna selections are saved locally.
