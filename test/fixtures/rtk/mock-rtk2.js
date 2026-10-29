// Invented network/address and synthetic RTCM only; no captured packets.
const inverse = [10, 9, 11, 0, 12, 8, 13, 1, 14, 7, 15, 2, 6, 3, 5, 4];
const key = [0xab, 0x37, 0x69, 0x38, 0xbc, 0xa3, 0x3f, 0xfd];
const swap = (x) => ((x << 4) | (x >> 4)) & 255;

export function mockRtk2Wire(bytes) {
	const out = new Uint8Array(bytes.length);
	for (let at = 0; at < bytes.length; at += 8) {
		const count = Math.min(8, bytes.length - at);
		if (count < 8) {
			for (let i = 0; i < count; i++) {
				const v = swap(bytes[at + i]) ^ 0xa3;
				const map = [2, 6, 0, 7, 5, 4, 1, 3];
				const b = map.reduce((n, bit, index) => n | (((v >> bit) & 1) << index), 0);
				out[at + i] = (inverse[b >> 4] << 4) | inverse[b & 15];
			}
			continue;
		}
		const n = [];
		for (let i = 0; i < 8; i++) {
			const v = swap(bytes[at + i]) ^ key[i];
			n.push(v >> 4, v & 15);
		}
		const parity = n.reduce((a, b) => a ^ b, 0);
		const transformed = [];
		for (let i = 0; i < 16; i += 2) transformed.push((inverse[n[i] ^ parity] << 4) | inverse[n[i + 1] ^ parity]);
		for (let row = 0; row < 8; row++)
			for (let column = 0; column < 8; column++) out[at + row] |= ((transformed[column] >> (7 - row)) & 1) << (7 - column);
	}
	return out;
}

export function mockRtk2Checks(bytes, bits) {
	let crc = bits === 16 ? 65535 : 0;
	for (const b of bytes) {
		crc ^= b;
		for (let i = 0; i < 8; i++) crc = (crc >> 1) ^ (crc & 1 ? (bits === 16 ? 0xa001 : 0x8c) : 0);
	}
	return crc;
}

export function mockRtk2Plain(payload, sequence = 100, address = 4242, network = 'TESTNET1') {
	const inner = Uint8Array.from([
		0xa5,
		0x5a,
		4,
		1,
		4,
		1,
		payload.length & 255,
		payload.length >> 8,
		sequence & 255,
		sequence >> 8,
		...payload,
	]);
	const crc = mockRtk2Checks(inner, 16);
	const body = [...inner, crc & 255, crc >> 8];
	const bytes = Uint8Array.from([
		0x5d,
		0xa6,
		...new TextEncoder().encode(network),
		address & 255,
		address >> 8,
		body.length,
		0,
		sequence & 255,
		...body,
	]);
	return Uint8Array.from([...bytes, mockRtk2Checks(bytes, 8), 13, 10]);
}

export function mockRtk2Packet(payload, sequence, address, network) {
	return {
		data: mockRtk2Wire(mockRtk2Plain(payload, sequence, address, network)),
		hasCrc: false,
		verified: false,
		codingRate: 1,
		codingErrors: 0,
		cfoHz: 600,
	};
}

export const mockRtk2Options = { rate: 1, hasCrc: false, ldro: false, oversample: 4, clockPpm: 10, preamble: 16, sync: [16, 8] };
