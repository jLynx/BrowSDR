import type { BleAdvertisement } from '@/worker/decoders/ble/types';
import type { MacVendorDatabase } from './types';

const decoder = new TextDecoder('ascii');

export function parseMacVendors(bytes: Uint8Array): MacVendorDatabase {
	const count = bytes.length / 71;
	if (!Number.isInteger(count) || count < 1 || count > 100000) throw new Error('Invalid MAC database size');
	let previous = '';
	for (let i = 0; i < count; i++) {
		const key = decoder.decode(bytes.subarray(i * 7, i * 7 + 6));
		const vendor = decoder.decode(bytes.subarray(count * 7 + i * 64, count * 7 + (i + 1) * 64));
		if (!/^[0-9A-F]{6}$/.test(key) || bytes[i * 7 + 6] !== 0 || key < previous || !/^[\x20-\x7e]{1,63}\0+$/.test(vendor))
			throw new Error('Invalid MAC database record');
		previous = key;
	}
	return { bytes, count };
}

export function macVendor(
	database: MacVendorDatabase | undefined,
	device: Pick<BleAdvertisement, 'address' | 'addressType'>,
): string | undefined {
	if (!database || device.addressType !== 'public' || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(device.address)) return;
	const key = device.address.slice(0, 8).replaceAll(':', '').toUpperCase();
	let low = 0,
		high = database.count - 1;
	while (low <= high) {
		const index = Math.floor((low + high) / 2);
		const candidate = decoder.decode(database.bytes.subarray(index * 7, index * 7 + 6));
		if (candidate === key) {
			const start = database.count * 7 + index * 64;
			return decoder
				.decode(database.bytes.subarray(start, start + 64))
				.replace(/\0.*$/, '')
				.trim();
		}
		if (candidate < key) low = index + 1;
		else high = index - 1;
	}
}
