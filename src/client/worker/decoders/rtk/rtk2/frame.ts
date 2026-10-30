import type { LoraPacket } from '@/worker/decoders/rtk/types';
import { crc16Modbus } from '@/worker/decoders/rtk/rtk3/frame';
import { decodeRtk2Bytes } from './transform';
import type { Rtk2Frame } from './types';

export function crc8Maxim(data: Uint8Array): number {
	let crc = 0;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x8c : 0);
	}
	return crc;
}

/** Mammotion writes its 16-bit loc ID as eight zero-padded decimal ASCII bytes. */
function decimalLoc(bytes: Uint8Array): number | undefined {
	let value = 0;
	for (const byte of bytes) {
		if (byte < 48 || byte > 57) return;
		value = value * 10 + byte - 48;
	}
	return value <= 65535 ? value : undefined;
}

function identity(data: Uint8Array) {
	return {
		network: Array.from(data.subarray(2, 10), (byte) => byte.toString(16).padStart(2, '0')).join(''),
		loc: decimalLoc(data.subarray(2, 10)),
		address: data[10] | (data[11] << 8),
	};
}

/** Captured hopping variant: a 14-byte header, raw stream bytes and CRC8, without CR/LF. */
function compactFrame(data: Uint8Array): Rtk2Frame | undefined {
	if (data[13] > 240 || data[13] !== data.length - 15 || crc8Maxim(data.subarray(0, -1)) !== data[data.length - 1]) return;
	// Byte 12 matches the radio slot in verified control beacons; it is not a packet sequence.
	return { format: 'compact', ...identity(data), loc: undefined, hopSlot: data[12], body: data.slice(14, -1) };
}

function compactBeacon(data: Uint8Array): Rtk2Frame | undefined {
	if (data.length !== 23 || data[12] > 17 || data[13] !== 0 || data[14] !== 30 || data[15] !== 0 || data[20] !== 0 || data[21] !== 0)
		return;
	if (crc8Maxim(data.subarray(0, -1)) !== data[22]) return;
	return {
		format: 'compact',
		...identity(data),
		loc: undefined,
		hopSlot: data[12],
		beaconSeconds: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(16, true),
		body: new Uint8Array(0),
	};
}

/** Validated DU1021D outer frame containing one checksummed correction-stream chunk. */
export function decodeRtk2Frame(packet: LoraPacket): Rtk2Frame | undefined {
	if (packet.hasCrc || packet.codingRate !== 1 || packet.codingErrors || packet.data.length < 15 || packet.data.length > 255) return;
	const data = decodeRtk2Bytes(packet.data);
	if (data[0] !== 0x5d || data[1] !== 0xa6) return;
	if (data[13] === data.length - 15) return compactFrame(data);
	if (data.length === 23) return compactBeacon(data);
	if (data.length < 30) return;
	const end = data.length - 3;
	if (data[0] !== 0x5d || data[1] !== 0xa6 || data[end + 1] !== 13 || data[end + 2] !== 10) return;
	if ((data[12] | (data[13] << 8)) !== data.length - 18 || crc8Maxim(data.subarray(0, end)) !== data[end]) return;
	const body = data.subarray(15, end);
	if (![0xa5, 0x5a, 4, 1, 4, 1].every((byte, i) => body[i] === byte)) return;
	const length = body[6] | (body[7] << 8);
	if (
		length + 12 !== body.length ||
		crc16Modbus(body.subarray(0, body.length - 2)) !== (body[body.length - 2] | (body[body.length - 1] << 8))
	)
		return;
	return {
		format: 'container',
		...identity(data),
		sequence: body[8] | (body[9] << 8),
		body: body.slice(10, -2),
	};
}
