import type { BleAdvertisement, BleDevice } from '@/worker/decoders/ble/types';

export function mergeAdvertisements(devices: BleDevice[], packets: BleAdvertisement[], now = Date.now()): BleDevice[] {
	const map = new Map(
		devices.filter((device) => now - device.lastSeen < 300000).map((device) => [`${device.addressType}:${device.address}`, device]),
	);
	for (const packet of packets) {
		const key = `${packet.addressType}:${packet.address}`;
		const old = map.get(key);
		const device = {
			...old,
			...packet,
			firstSeen: old?.firstSeen ?? now,
			lastSeen: now,
			packets: (old?.packets ?? 0) + 1,
			channels: [...new Set([...(old?.channels ?? []), packet.channel])].sort(),
			services: [...new Set([...(old?.services ?? []), ...packet.services])].slice(0, 64),
			serviceData: packet.serviceData.length ? packet.serviceData : (old?.serviceData ?? []),
		};
		if (old?.name && (!packet.name || (old.completeName && !packet.completeName))) {
			device.name = old.name;
			device.completeName = old.completeName;
		}
		map.set(key, device);
	}
	return [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 500);
}

export function manufacturerText(id?: number): string {
	if (id === undefined) return '—';
	return (
		(
			{ 0x004c: 'Apple', 0x0006: 'Microsoft', 0x0075: 'Samsung', 0x00e0: 'Google', 0x0059: 'Nordic Semiconductor' } as Record<
				number,
				string
			>
		)[id] ?? `0x${id.toString(16).padStart(4, '0').toUpperCase()}`
	);
}
