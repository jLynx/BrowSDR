/** USB serials are often factory defaults shared by several RTL-SDR dongles. */
const deviceSettingsKeys = new WeakMap<USBDevice, string>();

export function usbSettingsKey(device: USBDevice, paired: USBDevice[]): string {
	const index = paired.indexOf(device);
	if (index < 0) throw new Error('SDR is no longer connected');
	const base = `SDRSetting:usb:${device.vendorId}:${device.productId}`;
	const serial = device.serialNumber;
	const identity = serial ? `${base}:${serial}` : base;
	const duplicates = paired.filter(
		(item) => item.vendorId === device.vendorId && item.productId === device.productId && item.serialNumber === serial,
	);
	const registryKey = `${identity}:device-keys`;
	const { keys, storage }: { keys: string[]; storage: Storage | undefined } = loadDeviceKeyRegistry(registryKey, identity);
	const used = new Set(duplicates.map((item) => deviceSettingsKeys.get(item)).filter(Boolean));
	for (const item of duplicates) {
		const cached = deviceSettingsKeys.get(item);
		if (cached) {
			if (!keys.includes(cached)) keys.push(cached);
			continue;
		}
		let key = keys.find((candidate) => !used.has(candidate));
		if (!key) {
			// Preserve the original serial key for the first device, even after a collision.
			key = !keys.length ? (serial ? identity : `${identity}:index-${paired.indexOf(item)}`) : `${identity}:device-${keys.length}`;
			keys.push(key);
		}
		deviceSettingsKeys.set(item, key);
		used.add(key);
		try {
			// Migrate indexed keys written by the earlier multi-SDR implementation.
			const oldKey = serial ? `${identity}:index-${paired.indexOf(item)}` : `${base}:index-${paired.indexOf(item)}`;
			const oldSettings = storage?.getItem(oldKey);
			if (!storage?.getItem(key) && oldSettings) storage?.setItem(key, oldSettings);
		} catch {
			/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
		}
	}
	try {
		storage?.setItem(registryKey, JSON.stringify(keys));
	} catch {
		/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
	}
	return deviceSettingsKeys.get(device)!;
}

function loadDeviceKeyRegistry(registryKey: string, identity: string) {
	let storage: Storage | undefined;
	let keys: string[] = [];
	try {
		storage = globalThis.localStorage;
		const saved: unknown = JSON.parse(storage?.getItem(registryKey) || '[]');
		if (Array.isArray(saved))
			keys = saved.filter((key: unknown): key is string => typeof key === 'string' && (key.startsWith(identity + ':') || key === identity));
	} catch {
		/* Best-effort cleanup or optional capability; retain the current state if unavailable. */
	}
	return { keys, storage };
}

/** Workers cannot receive USBDevice objects, so open the exact selected list entry. */
export function selectUsbDevice(
	devices: USBDevice[],
	opts?: {
		deviceIndex?: number;
		vendorId?: number;
		productId?: number;
		serialNumber?: string;
	},
): USBDevice | undefined {
	const matches = (device: USBDevice | undefined) =>
		device &&
		(!opts ||
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
