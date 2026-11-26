// Synthetic encoders shared with the established decoder regression waveforms.
const offsets = [0xfc, 0x198, 0x168, 0x1b4];

function blockBits(data, index) {
	let remainder = data << 10;
	for (let bit = 25; bit >= 10; bit--) {
		if ((remainder >>> bit) & 1) remainder ^= 0x5b9 << (bit - 10);
	}
	const block = (data << 10) | (remainder ^ offsets[index]);
	return Array.from({ length: 26 }, (_, bit) => (block >>> (25 - bit)) & 1);
}

function groupBits(words) {
	return words.flatMap(blockBits);
}

export function stationBits() {
	const groups = [];
	const ps = 'channelX';
	for (let segment = 0; segment < 4; segment++) {
		groups.push(groupBits([0x9240, segment, 0, (ps.charCodeAt(segment * 2) << 8) | ps.charCodeAt(segment * 2 + 1)]));
	}
	const rt = 'Madness - Our House\r'.padEnd(20, ' ');
	for (let segment = 0; segment < 5; segment++) {
		const base = segment * 4;
		groups.push(
			groupBits([
				0x9240,
				0x2000 | segment,
				(rt.charCodeAt(base) << 8) | rt.charCodeAt(base + 1),
				(rt.charCodeAt(base + 2) << 8) | rt.charCodeAt(base + 3),
			]),
		);
	}
	return groups.flat();
}

export function makeMpx(bits, sampleRate, phase = 0, noise = 0) {
	let previous = 1;
	const symbols = bits.flatMap((bit) => {
		if (bit) previous = -previous;
		return [previous, -previous];
	});
	const samples = new Float32Array(Math.ceil((symbols.length * sampleRate) / 2375));
	let random = 12345;
	let shaped = 0;
	const alpha = 1 - Math.exp((-2 * Math.PI * 2400) / sampleRate);
	for (let index = 0; index < samples.length; index++) {
		const t = index / sampleRate;
		const symbol = symbols[Math.min(symbols.length - 1, Math.floor(t * 2375))];
		shaped += alpha * (symbol - shaped);
		random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
		samples[index] =
			0.1 * Math.cos(2 * Math.PI * 19000 * t) +
			0.03 * shaped * Math.cos(2 * Math.PI * 57000 * t + phase) +
			0.3 * Math.sin(2 * Math.PI * 1000 * t) +
			noise * ((random / 0xffffffff) * 2 - 1);
	}
	return samples;
}

export function wavemanIq(rate, carrier = 0) {
	const pulses = [];
	let samples = 0;
	const add = (us, high) => {
		const count = Math.round((us * rate) / 1e6);
		pulses.push({ count, high });
		samples += count;
	};
	add(20000, false);
	for (let repeat = 0; repeat < 4; repeat++) {
		for (const nibble of [3, 6, 14])
			for (let bit = 0; bit < 4; bit++) {
				for (const one of [true, !(nibble & (1 << bit))]) {
					add(one ? 357 : 1064, true);
					add(one ? 1064 : 357, false);
				}
			}
		add(357, true);
		add(16000, false);
	}
	add(30000, false);
	const iq = new Float32Array(samples * 2);
	let pos = 0;
	for (const pulse of pulses)
		for (let i = 0; i < pulse.count; i++, pos++) {
			const amplitude = pulse.high ? 0.5 : 0.001;
			const phase = (2 * Math.PI * carrier * pos) / rate;
			iq[2 * pos] = amplitude * Math.cos(phase);
			iq[2 * pos + 1] = amplitude * Math.sin(phase);
		}
	return iq;
}
