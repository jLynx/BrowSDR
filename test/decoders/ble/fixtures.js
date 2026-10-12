// Independent forward polynomial / bit reversal CRC implementation for generated radio frames.
export function crc(bytes) {
	let state = 0x555555;
	for (const byte of bytes)
		for (let bit = 0; bit < 8; bit++) {
			const feedback = ((state >> 23) ^ (byte >> bit)) & 1;
			state = (state << 1) & 0xffffff;
			if (feedback) state ^= 0x65b;
		}
	let reversed = 0;
	for (let bit = 0; bit < 24; bit++) reversed |= ((state >> bit) & 1) << (23 - bit);
	return reversed;
}

export function advertisement(type = 0, data = [5, 9, 84, 69, 83, 84, 3, 3, 0x0f, 0x18, 4, 0xff, 0x4c, 0, 0x12]) {
	const body = Uint8Array.from([type | 0x40, 6 + data.length, 1, 2, 3, 4, 5, 0xc6, ...data]);
	const checksum = crc(body);
	return Uint8Array.from([...body, checksum & 255, (checksum >> 8) & 255, checksum >> 16]);
}

export function wireBits(bytes, channel = 37) {
	const bits = [];
	for (const byte of [0xaa, 0xd6, 0xbe, 0x89, 0x8e]) for (let bit = 0; bit < 8; bit++) bits.push((byte >> bit) & 1);
	let state = channel | 0x40;
	for (const byte of bytes)
		for (let bit = 0; bit < 8; bit++) {
			bits.push(((byte >> bit) & 1) ^ (state & 1));
			// Fibonacci whitening x^7 + x^4 + 1, using the serial state convention.
			const out = state & 1;
			state >>= 1;
			if (out) state ^= 0x44;
		}
	return bits;
}

/** Gaussian pulse shaped LE 1M IQ with arbitrary symbol phase, CFO, noise and input rate. */
export function radioSignal(bytes = advertisement(), channel = 37, rate = 2000000, offset = 0, symbolPhase = 0, invert = false, noise = 0) {
	const bits = wireBits(bytes, channel);
	const sps = rate / 1000000;
	const output = new Float32Array(Math.ceil((bits.length + 240) * sps) * 2);
	const sigma = Math.sqrt(Math.log(2)) / (2 * Math.PI * 0.5);
	let phase = 0,
		random = 123;
	for (let i = 0; i < output.length / 2; i++) {
		const time = i / sps - 40 + symbolPhase;
		let shaped = 0,
			weight = 0;
		for (let k = Math.floor(time) - 2; k <= Math.floor(time) + 2; k++) {
			const w = Math.exp(-((time - k - 0.5) ** 2) / (2 * sigma ** 2));
			shaped += ((bits[k] ?? 0) * 2 - 1) * w;
			weight += w;
		}
		phase += (2 * Math.PI * (offset + (250000 * shaped) / weight)) / rate;
		random = (random * 1664525 + 1013904223) >>> 0;
		output[2 * i] = 0.65 * Math.cos(phase) + (random / 2 ** 32 - 0.5) * noise;
		random = (random * 1664525 + 1013904223) >>> 0;
		output[2 * i + 1] = (invert ? -1 : 1) * 0.65 * Math.sin(phase) + (random / 2 ** 32 - 0.5) * noise;
	}
	return output;
}
