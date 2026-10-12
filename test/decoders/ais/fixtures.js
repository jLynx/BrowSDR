import { aisCrc } from '@/worker/decoders/ais/hdlc';

export function report(type = 1, mmsi = 512123456, size = 21) {
	const bytes = new Uint8Array(size);
	const set = (start, width, value) => {
		if (value < 0) value += 2 ** width;
		for (let bit = 0; bit < width; bit++)
			bytes[(start + bit) >> 3] |= (Math.floor(value / 2 ** (width - bit - 1)) & 1) << (7 - ((start + bit) & 7));
	};
	const text = (start, value, length) => {
		for (let i = 0; i < length; i++) set(start + i * 6, 6, (value.charCodeAt(i) || 64) & 63);
	};
	set(0, 6, type);
	set(8, 30, mmsi);
	return { bytes, set, text };
}

export function positionReport() {
	const frame = report();
	frame.set(38, 4, 5);
	frame.set(50, 10, 123);
	frame.set(61, 28, Math.round(174.76 * 600000));
	frame.set(89, 27, Math.round(-36.84 * 600000));
	frame.set(116, 12, 2712);
	frame.set(128, 9, 270);
	return frame.bytes;
}

export function wireBits(payload, corrupt = false) {
	const checksum = aisCrc(payload) ^ (corrupt ? 1 : 0);
	const bytes = [...payload, checksum & 255, checksum >> 8];
	const bits = Array.from({ length: 40 }, (_, i) => i & 1);
	const flag = [0, 1, 1, 1, 1, 1, 1, 0];
	bits.push(...flag);
	let ones = 0;
	for (const byte of bytes)
		for (let bit = 0; bit < 8; bit++) {
			const value = (byte >> bit) & 1;
			bits.push(value);
			ones = value ? ones + 1 : 0;
			if (ones === 5) {
				bits.push(0);
				ones = 0;
			}
		}
	bits.push(...flag, ...flag, ...Array(32).fill(0));
	return bits;
}

/** Independently synthesize Gaussian-shaped NRZI frequency modulation, with carrier offset and optional noise. */
export function radioSignal(payload, rate = 48000, offset = 0, noise = 0, phaseOffset = 0) {
	const bits = wireBits(payload);
	let level = 1;
	const levels = bits.map((bit) => {
		if (!bit) level = -level;
		return level;
	});
	const symbolSamples = rate / 9600;
	const length = Math.ceil((levels.length + 20) * symbolSamples);
	const output = new Float32Array(length * 2);
	const sigma = Math.sqrt(Math.log(2)) / (2 * Math.PI * 0.4);
	let phase = 0;
	let random = 12345;
	for (let i = 0; i < length; i++) {
		const time = i / symbolSamples - 10 + phaseOffset;
		const center = Math.floor(time);
		let shaped = 0;
		let weight = 0;
		for (let symbol = center - 2; symbol <= center + 2; symbol++) {
			const delta = time - symbol - 0.5;
			const amount = Math.exp((-delta * delta) / (2 * sigma * sigma));
			shaped += (levels[symbol] ?? 1) * amount;
			weight += amount;
		}
		phase += (2 * Math.PI * (offset + (2400 * shaped) / weight)) / rate;
		random = (random * 1664525 + 1013904223) >>> 0;
		output[i * 2] = 0.7 * Math.cos(phase) + (random / 2 ** 32 - 0.5) * noise;
		random = (random * 1664525 + 1013904223) >>> 0;
		output[i * 2 + 1] = 0.7 * Math.sin(phase) + (random / 2 ** 32 - 0.5) * noise;
	}
	return output;
}
