import type { LoraPacket } from '@/worker/decoders/rtk/types';
import { crc16Modbus } from '@/worker/decoders/rtk/rtk3/frame';
import { decodeRtk2Bytes } from './transform';

export function crc8Maxim(data: Uint8Array): number {
	let crc = 0;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x8c : 0);
	}
	return crc;
}

/** Validated DU1021D outer frame containing one checksummed correction-stream chunk. */
export function decodeRtk2Frame(packet: LoraPacket) {
	if (packet.hasCrc || packet.codingRate !== 1 || packet.codingErrors || packet.data.length < 30 || packet.data.length > 255) return;
	const data = decodeRtk2Bytes(packet.data);
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
		network: Array.from(data.subarray(2, 10), (byte) => byte.toString(16).padStart(2, '0')).join(''),
		address: data[10] | (data[11] << 8),
		sequence: body[8] | (body[9] << 8),
		body: body.slice(10, -2),
	};
}
