import { describe, expect, it } from 'vitest';
import { IqCapture } from '@/worker/recording/iq-capture';

describe('raw IQ capture', () => {
	it.each([null, 5])('saves only captured samples when stopped early (duration %s)', async (seconds) => {
		const capture = new IqCapture();
		const done = capture.start(2, seconds);
		capture.push(new Int8Array([1, -1, 2, -2]));
		capture.stop();
		capture.push(new Int8Array([3, -3]));
		expect(Array.from(await done)).toEqual([1, -1, 2, -2]);
		expect(capture.progress).toBeNull();
	});
	it('completes manual memory recording at the download limit', async () => {
		const capture = new IqCapture();
		const done = capture.start(2, null);
		const limit = capture.progress.totalBytes;
		capture.push(new Int8Array(limit + 2));
		expect((await done).length).toBe(64 * 1024 * 1024);
	});
	it('rejects stopping before any samples arrive', async () => {
		const capture = new IqCapture();
		const done = capture.start(2, null);
		const rejection = expect(done).rejects.toThrow('No IQ samples');
		capture.stop();
		await rejection;
	});
	it('copies reused USB buffers and stops on the exact complex sample boundary', async () => {
		const capture = new IqCapture();
		const done = capture.start(3, 1);
		const input = new Int8Array([-128, 127, 1, -1]);
		capture.push(input);
		input.fill(42);
		capture.push(new Int8Array([2, -2, 3, -3]));
		expect(Array.from(await done)).toEqual([-128, 127, 1, -1, 2, -2]);
	});
	it('bounds allocations and rejects a concurrent recording', async () => {
		const capture = new IqCapture();
		for (const seconds of [NaN, Infinity, -1, 0, 100]) expect(() => capture.start(1e6, seconds)).toThrow();
		for (const sampleRate of [NaN, Infinity, -1, 0]) expect(() => capture.start(sampleRate, 1)).toThrow();
		const done = capture.start(1e6, 1);
		expect(() => capture.start(1e6, 1)).toThrow('already running');
		const rejection = expect(done).rejects.toThrow('retuned');
		capture.cancel('retuned');
		await rejection;
	});
});
