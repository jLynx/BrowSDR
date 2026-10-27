// Test-only LoRa encoder. No input from RF recordings or the decoder under test.
const parity = (value) => (value.toString(2).split('1').length % 2) ^ 1;
const mod = (value, base) => ((value % base) + base) % base;

function word(nibble, rate) {
	const [a, b, c, d] = [0, 1, 2, 3].map((bit) => (nibble >> bit) & 1);
	return (
		((a << 7) | (b << 6) | (c << 5) | (d << 4) | ((a ^ b ^ c) << 3) | ((b ^ c ^ d) << 2) | ((a ^ b ^ d) << 1) | (a ^ c ^ d)) >> (4 - rate)
	);
}

function block(nibbles, rate) {
	const words = nibbles.map((nibble) => word(nibble, rate)),
		bits = words.length,
		columns = rate + 4;
	return Array.from({ length: columns }, (_, column) => {
		let gray = 0;
		for (let bit = 0; bit < bits; bit++) gray |= ((words[mod(column - bit - 1, bits)] >> (columns - column - 1)) & 1) << (bits - bit - 1);
		let bin = gray;
		for (let shift = 1; shift < bits; shift <<= 1) bin ^= bin >> shift;
		return (4 * bin + 1) % 128;
	});
}

function crc16(bytes) {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 65535;
	}
	return crc;
}

export function mockSymbols(payload) {
	const input = (payload.length << 4) | 5; // CR4/6, payload CRC enabled.
	const check = [0xf00, 0x8e1, 0x49a, 0x257, 0x12f].reduce((value, mask) => (value << 1) | parity(input & mask), 0);
	const symbols = block([payload.length >> 4, payload.length & 15, 5, check >> 4, check & 15], 4);
	const crc = crc16(payload.subarray(0, -2)) ^ (payload.at(-2) << 8) ^ payload.at(-1);
	const bytes = Uint8Array.from([...payload, crc & 255, crc >> 8]);
	let whitening = 255;
	for (let i = 0; i < payload.length; i++) {
		bytes[i] ^= whitening;
		const feedback = ((whitening >> 7) ^ (whitening >> 5) ^ (whitening >> 4) ^ (whitening >> 3)) & 1;
		whitening = ((whitening << 1) | feedback) & 255;
	}
	const nibbles = Array.from(bytes).flatMap((byte) => [byte & 15, byte >> 4]);
	while (nibbles.length % 5) nibbles.push(0);
	for (let i = 0; i < nibbles.length; i += 5) symbols.push(...block(nibbles.slice(i, i + 5), 2));
	return symbols;
}
