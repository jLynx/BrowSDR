import { describe, expect, it } from 'vitest';
import { FT8Stream } from '../src/client/ft8/stream';

describe('FT8 UTC capture', () => {
	it('keeps nine interleaved captures independent across the same UTC slots', () => {
		const frames = Array.from({ length: 9 }, () => []);
		const streams = frames.map(results => new FT8Stream((audio, slot) => results.push({ audio, slot })));
		for (let time = 100; time <= 31000; time += 100) {
			streams.forEach((stream, index) => stream.push(new Float32Array(4800).fill((index + 1) / 10), time));
		}
		frames.forEach((results, index) => {
			expect(results.map(frame => frame.slot)).toEqual([0, 15000]);
			expect(results[0].audio[90000]).toBeCloseTo((index + 1) / 10);
		});
	});
	it('discards the first partial slot and preserves complete slots across USB burst sizes', () => {
		const frames = [];
		const stream = new FT8Stream((audio, slot) => frames.push({ audio, slot }));
		let time = 4200;
		for (let i = 0; i < 900; i++) {
			const size = [2400, 4032, 3552][i % 3];
			time += size / 48;
			stream.push(new Float32Array(size).fill(0.1), time + (i % 2 ? 30 : -30));
		}
		expect(frames.length).toBeGreaterThan(2);
		expect(frames[0].slot).toBe(15000);
		frames.forEach((frame, index) => {
			expect(frame.slot).toBe(15000 * (index + 1));
			expect(frame.audio.length).toBe(180000);
			expect(frame.audio[90000]).toBeCloseTo(0.1);
		});
	});
	it('discards an interrupted slot rather than joining audio across a gap', () => {
		const frames = [];
		const stream = new FT8Stream((audio, slot) => frames.push(slot));
		for (let time = 100; time <= 9000; time += 100) stream.push(new Float32Array(4800), time);
		for (let time = 12100; time <= 30000; time += 100) stream.push(new Float32Array(4800), time);
		expect(frames).toEqual([15000]);
	});
});
