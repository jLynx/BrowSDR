// An ARINC 618 downlink layout: mode, seven-character address, ACK, label,
// block ID, STX, four-character message number, six-character flight ID, text, ETX.
export const parity = (value) => {
	let count = 0;
	for (let bit = 0; bit < 7; bit++) count += (value >> bit) & 1;
	return value | (count % 2 === 0 ? 0x80 : 0);
};
export function payload(text = 'ARRIVAL GATE 12\r\nETA 1234', block = '1', ending = 3) {
	return Uint8Array.from(
		[...`2.ZK-NZE${String.fromCharCode(21)}H1${block}\x02${/\d/.test(block) ? 'M01AANZ001' : ''}${text}`, String.fromCharCode(ending)],
		(char) => parity(char.charCodeAt(0)),
	);
}
// Independent polynomial-long-division BCS encoder, deliberately MSB-oriented.
export function wireBytes(frame = payload()) {
	let crc = 0;
	for (const byte of frame)
		for (let bit = 0; bit < 8; bit++) {
			const input = (byte >> bit) & 1;
			const top = ((crc >> 15) & 1) ^ input;
			crc = (crc << 1) & 0xffff;
			if (top) crc ^= 0x1021;
		}
	let reflected = 0;
	for (let bit = 0; bit < 16; bit++) reflected |= ((crc >> bit) & 1) << (15 - bit);
	return Uint8Array.from([0x16, 0x16, 0x01, ...frame, reflected & 255, reflected >> 8, 0x7f]);
}

export function radioSignal(frame = payload(), rate = 48000, offset = 0, phase = 0, clockError = 0) {
	const bits = [...Array(160).fill(1)];
	for (const byte of wireBytes(frame)) for (let bit = 0; bit < 8; bit++) bits.push((byte >> bit) & 1);
	bits.push(...Array(100).fill(1));
	const result = new Float32Array(Math.ceil((bits.length * rate) / (2400 * (1 + clockError))) * 2);
	let audioPhase = phase;
	let previous = 1;
	let symbol = -1;
	let tone = 2400;
	for (let i = 0; i < result.length / 2; i++) {
		const next = Math.min(bits.length - 1, Math.floor((i * 2400 * (1 + clockError)) / rate));
		if (next !== symbol) {
			tone = bits[next] === previous ? 2400 : 1200;
			previous = bits[next];
			symbol = next;
		}
		audioPhase += (2 * Math.PI * tone) / rate;
		const amplitude = 0.5 * (1 + 0.7 * Math.cos(audioPhase));
		const carrier = (2 * Math.PI * offset * i) / rate + 0.7;
		result[i * 2] = amplitude * Math.cos(carrier);
		result[i * 2 + 1] = amplitude * Math.sin(carrier);
	}
	return result;
}
