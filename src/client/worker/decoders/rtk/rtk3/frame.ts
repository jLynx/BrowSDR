import type { LoraPacket } from '@/worker/decoders/rtk/types';
import type { Rtk3Frame } from './types';

export function crc16Modbus(data: Uint8Array): number {
	let crc = 0xffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xa001 : 0);
	}
	return crc;
}

/** RBS03 framing documented by VE2MRX in mammotion-rtk-lora/PROTOCOL.md. */
export function decodeRtk3Frame(packet: LoraPacket): Rtk3Frame | undefined {
	const data = packet.data;
	if (packet.hasCrc || packet.codingRate !== 1 || packet.codingErrors) return;
	if (data.length < 7 || data.length > 231) return;
	const trailer = data.length - 2;
	if (crc16Modbus(data.subarray(0, trailer)) !== (data[trailer] | (data[trailer + 1] << 8))) return;
	const address = data[2] | (data[3] << 8);
	const addressPrefix = data[0] | (data[1] << 8) || undefined;
	const body = data.subarray(4, trailer);
	if (body[0] === 0x55 && body[1] === 0x55) {
		if (data.length !== 21 || body[2] !== 0 || body[3] !== 0x40) return;
		if (body.subarray(8, 13).some((byte) => byte !== 0) || body[13] !== 0xaa || body[14] !== 0xaa) return;
		const beaconMs = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(4, true);
		return { address, addressPrefix, body, beaconMs };
	}
	return { address, addressPrefix, body };
}
