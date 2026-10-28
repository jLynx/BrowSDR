import { mockRadioPayload } from './mock-packet.js';

// Invented RTK3 address and RTCM coordinates. No captured RF or private IDs.
export const mockRtk3Address = 4242;
export const mockRtk3Options = {
	rate: 1,
	hasCrc: false,
	ldro: false,
	oversample: 4,
	clockPpm: 0,
	preamble: 16,
	sync: [8, 16],
};

export function mockRtcmReference(ecef) {
	const radio = mockRadioPayload(undefined, ecef);
	const length = (radio[10] ^ 0x12) + 6;
	return radio.slice(8, 8 + length).map((byte) => byte ^ 0x12);
}

export function mockRtk3Container(payload = mockRtcmReference(), sequence = 100, type = 1) {
	return Uint8Array.from([
		0xa5,
		0x5a,
		0x04,
		0x01,
		0x04,
		type,
		payload.length & 255,
		payload.length >> 8,
		sequence & 255,
		sequence >> 8,
		...payload,
	]);
}

export function mockRtk3Packet(body, address = mockRtk3Address) {
	const bytes = Uint8Array.from([0, 0, address & 255, address >> 8, ...body]);
	let crc = 0xffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >> 1) ^ (crc & 1 ? 0xa001 : 0);
	}
	return {
		data: Uint8Array.from([...bytes, crc & 255, crc >> 8]),
		verified: false,
		hasCrc: false,
		codingRate: 1,
		codingErrors: 0,
		cfoHz: 630,
	};
}

export function mockRtk3Beacon(address = mockRtk3Address, ms = 15000) {
	const body = new Uint8Array(15);
	body.set([0x55, 0x55, 0, 0x40]);
	new DataView(body.buffer).setUint32(4, ms, true);
	body.set([0xaa, 0xaa], 13);
	return mockRtk3Packet(body, address);
}
