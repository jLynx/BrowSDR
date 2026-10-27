// Entirely invented station: scan 1234, channel 7, net 42; position at 0°, 0°.
export const mockPairing = { scan: 1234, channel: 7, netId: 42 };

function pack(fields) {
	const bits = fields.map(([value, width]) => BigInt.asUintN(width, BigInt(value)).toString(2).padStart(width, '0')).join('');
	return Uint8Array.from({ length: Math.ceil(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 2));
}

function checksum(bytes) {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte << 16;
		for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x800000 ? 0x1864cfb : 0)) & 0xffffff;
	}
	return crc;
}

export function mockRadioPayload(pairing = mockPairing, ecef = [63781370000, 0, 0]) {
	const body = pack([
		[1006, 12],
		[42, 12],
		[0, 6],
		[0, 4],
		[ecef[0], 38],
		[0, 2],
		[ecef[1], 38],
		[0, 2],
		[ecef[2], 38],
		[12345, 16],
	]);
	const header = Uint8Array.from([0xd3, 0, body.length, ...body]);
	const crc = checksum(header);
	const frame = Uint8Array.from([...header, crc >> 16, (crc >> 8) & 255, crc & 255]);
	// Keep a long packet to exercise clock drift, buffering and USB sequence gaps.
	const radio = new Uint8Array(248).fill(0x12);
	radio.set([0x2c, pairing.channel, 0, 0, pairing.netId, pairing.scan >> 8, pairing.scan & 255, 240]);
	radio.set(
		frame.map((byte) => byte ^ 0x12),
		8,
	);
	return radio;
}
