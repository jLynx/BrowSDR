/** USB serials are often factory defaults shared by several RTL-SDR dongles. */
export function usbSettingsKey(device: USBDevice, paired: USBDevice[]): string {
	const index = paired.indexOf(device);
	if (index < 0) throw new Error('SDR is no longer connected');
	const base = `SDRSetting:usb:${device.vendorId}:${device.productId}`;
	const serial = device.serialNumber;
	if (!serial) return `${base}:index-${index}`;
	const duplicates = paired.filter(item => item.vendorId === device.vendorId &&
		item.productId === device.productId && item.serialNumber === serial);
	return duplicates.length === 1 ? `${base}:${serial}` : `${base}:${serial}:index-${index}`;
}

/** Workers cannot receive USBDevice objects, so open the exact selected list entry. */
export function selectUsbDevice(devices: USBDevice[], opts?: {
	deviceIndex?: number; vendorId?: number; productId?: number; serialNumber?: string;
}): USBDevice | undefined {
	const matches = (device: USBDevice | undefined) => device && (!opts ||
		((opts.vendorId === undefined || device.vendorId === opts.vendorId) &&
		 (opts.productId === undefined || device.productId === opts.productId) &&
		 (opts.serialNumber === undefined || device.serialNumber === opts.serialNumber)));
	if (opts?.deviceIndex !== undefined) {
		const device = devices[opts.deviceIndex];
		return matches(device) ? device : undefined;
	}
	const candidates = devices.filter(matches);
	if (opts && candidates.length > 1) throw new Error('Multiple SDRs match this device. Select a specific SDR from the device picker.');
	return candidates[0];
}
