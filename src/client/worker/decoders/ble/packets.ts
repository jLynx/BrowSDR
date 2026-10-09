import type { BleAdvertisement } from './types';

export const BLE_CHANNELS = [
	{ channel: 37, frequency: 2402 },
	{ channel: 38, frequency: 2426 },
	{ channel: 39, frequency: 2480 },
];
export const BLE_RATE = 2000000;
export const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase();

/** Reflected Bluetooth CRC-24, advertising initializer 0x555555 in on-air bit order. */
export function bleCrc(bytes: Uint8Array): number {
	let crc = 0xaaaaaa;
	for (const byte of bytes) {
		for (let bit = 0; bit < 8; bit++) {
			const feedback = (crc ^ (byte >> bit)) & 1;
			crc >>>= 1;
			if (feedback) crc ^= 0xda6000;
		}
	}
	return crc;
}

export function validHeader(header: number, length: number): boolean {
	const type = header & 15;
	return !(header & 0x10) && ([0, 2, 4, 6].includes(type) ? length >= 6 && length <= 37 : type === 1 && length === 12);
}

export function parseAdvertisement(bytes: Uint8Array, channel: number, signalDbfs: number): BleAdvertisement | null {
	const length = bytes[1];
	if (bytes.length !== length + 5 || !validHeader(bytes[0], length)) return null;
	const end = length + 2;
	if (bleCrc(bytes.subarray(0, end)) !== (bytes[end] | (bytes[end + 1] << 8) | (bytes[end + 2] << 16))) return null;
	const type = bytes[0] & 15;
	const result: BleAdvertisement = {
		address: Array.from(bytes.subarray(2, 8))
			.reverse()
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join(':')
			.toUpperCase(),
		addressType: bytes[0] & 0x40 ? 'random' : 'public',
		pduType: ({ 0: 'ADV_IND', 1: 'ADV_DIRECT_IND', 2: 'ADV_NONCONN_IND', 4: 'SCAN_RSP', 6: 'ADV_SCAN_IND' } as Record<number, string>)[
			type
		],
		channel,
		services: [],
		serviceData: [],
		data: hex(bytes.subarray(8, end)),
		signalDbfs,
	};
	if (type !== 1) parseData(bytes.subarray(8, end), result);
	return result;
}

function parseData(data: Uint8Array, result: BleAdvertisement): void {
	for (let offset = 0; offset < data.length;) {
		const length = data[offset++];
		if (!length || offset + length > data.length) break;
		const type = data[offset];
		const value = data.subarray(offset + 1, offset + length);
		if ((type === 8 || type === 9) && (!result.completeName || type === 9)) {
			result.name = Array.from(new TextDecoder().decode(value))
				.filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
				.join('');
			result.completeName = type === 9;
		} else if (type === 0x0a && value.length === 1) result.txPower = (value[0] << 24) >> 24;
		else if (type === 0xff && value.length >= 2) {
			result.manufacturer = value[0] | (value[1] << 8);
			result.manufacturerData = hex(value.subarray(2));
		} else if ([2, 3, 4, 5, 6, 7].includes(type)) {
			const width = type < 4 ? 2 : type < 6 ? 4 : 16;
			for (let i = 0; i + width <= value.length; i += width) result.services.push(hex(value.slice(i, i + width).reverse()));
		} else if ([0x16, 0x20, 0x21].includes(type)) {
			const width = type === 0x16 ? 2 : type === 0x20 ? 4 : 16;
			if (value.length >= width) {
				const uuid = hex(value.slice(0, width).reverse());
				result.services.push(uuid);
				result.serviceData.push(`${uuid}: ${hex(value.subarray(width))}`);
			}
		}
		offset += length;
	}
	result.services = [...new Set(result.services)];
}
