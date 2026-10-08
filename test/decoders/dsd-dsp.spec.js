import { describe, expect, it } from 'vitest';
import { ClockRecovery, FIRFilter, FourFSKSlicer, rrcTaps } from '../../src/client/worker/decoders/dsd/dsd-dsp';

function recover(input, sizes) {
	const clock = new ClockRecovery();
	const symbols = [];
	let offset = 0;
	let chunk = 0;
	while (offset < input.length) {
		const size = sizes[chunk++ % sizes.length];
		clock.process(input.subarray(offset, offset + size));
		symbols.push(...clock.symbolBuf.subarray(0, clock.symbolCount));
		offset += size;
	}
	return symbols;
}

describe('DSD streaming clock recovery', () => {
	it('preserves symbol timing across arbitrary USB chunk boundaries', () => {
		const samples = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i * 0.21) * 0.4 + Math.cos(i * 0.031) * 0.2);
		const whole = recover(samples, [samples.length]);
		expect(whole.length).toBeGreaterThan(4700);
		expect(whole.length).toBeLessThan(4900);
		expect(recover(samples, [1, 7, 13, 1567, 3133])).toEqual(whole);
	});
	it('recovers all four DMR symbol levels after transmit and receive pulse shaping', () => {
		let seed = 123456789;
		const dibits = Uint8Array.from({ length: 20000 }, () => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return seed & 3;
		});
		const impulses = new Float32Array(dibits.length * 10 + 100);
		for (let i = 0; i < dibits.length; i++) impulses[10 * i] = [1, 3, -1, -3][dibits[i]] * 0.25;
		const taps = rrcTaps(65, 48000, 4800, 0.2);
		const transmitted = new Float32Array(impulses.length);
		const received = new Float32Array(impulses.length);
		new FIRFilter(taps).process(impulses, transmitted);
		new FIRFilter(taps).process(transmitted, received);
		const symbols = recover(received, [1567, 3133]);
		const slicer = new FourFSKSlicer();
		const decoded = symbols.map((symbol) => slicer.slice(symbol));
		// Combined filter delay is 64 samples; recovery settles onto symbol 6.
		let bestErrors = Infinity;
		for (let delay = 5; delay <= 8; delay++) {
			let errors = 0;
			for (let i = 500; i < dibits.length - 100; i++) if (decoded[i + delay] !== dibits[i]) errors++;
			bestErrors = Math.min(bestErrors, errors);
		}
		expect(bestErrors / (dibits.length - 600)).toBeLessThan(0.01);
	});
});
