// Invented MSM4 satellite IDs, station 42 and C/N0; no captured observations.
export function mockMsm(type, satellites, multipleMessage, epochMs = 1000) {
	const fields = [
		[type, 12],
		[42, 12],
	];
	if (type === 1084) fields.push([0, 3], [epochMs, 27]);
	else fields.push([epochMs, 30]);
	fields.push([Number(multipleMessage), 1], [0, 18]);
	for (let id = 1; id <= 64; id++) fields.push([Number(satellites.includes(id)), 1]);
	for (let id = 1; id <= 32; id++) fields.push([Number(id === 2), 1]);
	fields.push([2 ** satellites.length - 1, satellites.length], [0, satellites.length * 18], [0, satellites.length * 42]);
	for (const _satellite of satellites) fields.push([42, 6]);
	const bits = fields.map(([value, width]) => BigInt.asUintN(width, BigInt(value)).toString(2).padStart(width, '0')).join('');
	const payload = Uint8Array.from({ length: Math.ceil(bits.length / 8) }, (_, index) =>
		parseInt(bits.slice(index * 8, index * 8 + 8).padEnd(8, '0'), 2),
	);
	const frame = Uint8Array.from([0xd3, payload.length >> 8, payload.length & 255, ...payload]);
	// Independent test encoder's CRC24Q, with the same public polynomial as RTCM3.
	let crc = 0;
	for (const byte of frame) {
		crc ^= byte << 16;
		for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x800000 ? 0x1864cfb : 0)) & 0xffffff;
	}
	return Uint8Array.from([...frame, crc >> 16, (crc >> 8) & 255, crc & 255]);
}
