import { beforeEach, describe, expect, it, vi } from 'vitest';

const codec = vi.hoisted(() => ({ emit: null, reset: vi.fn(), process: vi.fn() }));
vi.mock('../src/client/worker/dsd/dsd-decoder', () => ({
	DSDDecoder: class {
		constructor(onAudio) { codec.emit = onAudio; }
		reset = codec.reset;
		process = codec.process;
	},
}));

import { DSDStream } from '../src/client/worker/dsd/dsd-stream';

beforeEach(() => { codec.reset.mockClear(); codec.process.mockReset(); });

describe('DSD audio pacing', () => {
	it('plays a voice burst over subsequent chunks without adding time to the stream', () => {
		const stream = new DSDStream(() => {});
		let calls = 0;
		codec.process.mockImplementation(() => {
			if (++calls === 20) codec.emit(new Float32Array(2880).fill(0.2));
		});
		let total = 0;
		let voiceChunks = 0;
		let activeChunks = 0;
		for (let i = 0; i < 65; i++) {
			const audio = stream.process(new Float32Array(960));
			expect(audio.length).toBe(480);
			total += audio.length;
			if (audio.some(sample => Math.abs(sample) > 0.01)) voiceChunks++;
			if (stream.audioActive) activeChunks++;
		}
		expect(total).toBe(65 * 480);
		expect(voiceChunks).toBeGreaterThanOrEqual(36);
		expect(voiceChunks).toBeLessThanOrEqual(37);
		expect(activeChunks).toBe(voiceChunks);
		expect(stream.audioActive).toBe(false);
	});
	it('clears queued speech and decoder state on retune, enable change and source-rate change', () => {
		const stream = new DSDStream(() => {});
		stream.configure(439.7, 12500, true, 2000000);
		codec.emit(new Float32Array(160).fill(0.5));
		stream.configure(439.575, 12500, true, 2000000);
		expect(stream.process(new Float32Array(960)).every(value => value === 0)).toBe(true);
		expect(stream.audioActive).toBe(false);
		stream.configure(439.575, 12500, false, 2000000);
		stream.configure(439.575, 12500, true, 2000000);
		stream.configure(439.575, 12500, true, 1920000);
		stream.configure(439.575, 12500, true, 1920000);
		expect(codec.reset).toHaveBeenCalledTimes(5);
	});
	it('clears speech when squelch closes and resumes with a fresh discriminator', () => {
		const stream = new DSDStream(() => {});
		codec.emit(new Float32Array(160).fill(0.5));
		expect(stream.process(new Float32Array(960), true).every(value => value === 0)).toBe(true);
		expect(stream.audioActive).toBe(false);
		expect(stream.process(new Float32Array(960)).every(value => value === 0)).toBe(true);
		expect(codec.reset).toHaveBeenCalledOnce();
	});
});
