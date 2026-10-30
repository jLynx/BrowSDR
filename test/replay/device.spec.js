import { afterEach, describe, expect, it, vi } from 'vitest';
import { IqReplayDevice } from '@/devices/iq-replay';
import { recordingFromSigmf } from '@/radio/iq-replay/metadata';

afterEach(() => vi.useRealTimers());

function recording(bytes = 100, sampleRate = 1000) {
	const data = Int8Array.from({ length: bytes }, (_, i) => (i % 256) - 128);
	const file = new File([data], 'test.sigmf-data');
	const slice = vi.spyOn(file, 'slice').mockImplementation((start, end) => ({ arrayBuffer: async () => data.buffer.slice(start, end) }));
	return { value: { file, sampleRate, centerHz: 923118000, frequencyShiftHz: 0 }, data, slice };
}

describe('IQ file replay source', () => {
	it.each([1000, 1000000, 20000000, 61440000])('paces complete ci8 pairs at %i SPS without loading the whole file', async (rate) => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		const { value, data, slice } = recording(rate === 1000 ? 50 : 600002, rate);
		const source = new IqReplayDevice(value),
			chunks = [],
			times = [];
		await source.startRx((bytes) => {
			chunks.push(bytes);
			times.push(performance.now());
		});
		await vi.runAllTimersAsync();
		expect(Array.from(chunks.flatMap((chunk) => Array.from(chunk)))).toEqual(Array.from(data));
		expect(slice.mock.calls.every(([start, end]) => end - start <= 262144 && start % 2 === 0 && end % 2 === 0)).toBe(true);
		expect(chunks.length).toBeGreaterThan(1);
		let delivered = 0;
		for (let i = 0; i < times.length; i++) {
			// Millisecond timers must not accumulate drift relative to sample time.
			expect(Math.abs(times[i] - (delivered / 2 / rate) * 1000)).toBeLessThan(1.01);
			delivered += chunks[i].length;
		}
		expect(source.progress.state).toBe('ended');
		expect(source.progress.seconds).toBe(data.length / 2 / rate);
		await source.close();
	});
	it('pauses a prefetched read, resumes without skipping or repeating samples, and rewinds explicitly', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		const { value, data } = recording();
		const source = new IqReplayDevice(value),
			chunks = [];
		await source.startRx((bytes) => chunks.push(...bytes));
		await vi.advanceTimersByTimeAsync(10);
		await source.stopRx();
		const at = source.progress.seconds;
		await vi.advanceTimersByTimeAsync(1000);
		expect(source.progress.seconds).toBe(at);
		await source.startRx((bytes) => chunks.push(...bytes));
		await vi.runAllTimersAsync();
		expect(chunks).toEqual(Array.from(data));
		source.rewind();
		expect(source.progress).toMatchObject({ state: 'ready', seconds: 0 });
		await source.close();
	});
	it('rejects wrong metadata settings and surfaces file read errors', async () => {
		const { value, slice } = recording();
		const source = new IqReplayDevice(value);
		expect(() => source.setSampleRate(2000000)).toThrow('fixed');
		expect(() => source.setFrequency(100000000)).toThrow('fixed');
		slice.mockImplementation(() => ({
			arrayBuffer: async () => {
				throw new Error('Disk unavailable');
			},
		}));
		await source.startRx(vi.fn());
		await Promise.resolve();
		await Promise.resolve();
		expect(source.progress).toMatchObject({ state: 'error', error: 'Disk unavailable' });
		await source.close();
	});
});

describe('SigMF replay metadata', () => {
	const metadata = (changes = {}) =>
		JSON.stringify({
			global: {
				'core:datatype': 'ci8',
				'core:sample_rate': 20000000,
				'browsdr:frequency_shift_hz': -125000000,
				'browsdr:missing_samples': null,
				...changes,
			},
			captures: [{ 'core:sample_start': 0, 'core:frequency': 225000000 }],
		});
	it('restores the original RF sample rate, SDR centre, display shift and unknown continuity', () => {
		const { value } = recording();
		expect(recordingFromSigmf(value.file, metadata())).toMatchObject({
			sampleRate: 20000000,
			centerHz: 225000000,
			frequencyShiftHz: -125000000,
			missingSamples: null,
		});
	});
	it.each([{ 'core:datatype': 'cf32_le' }, { 'core:sample_rate': 0 }, { 'core:offset': 8 }])(
		'rejects incompatible metadata %o',
		(changes) => {
			expect(() => recordingFromSigmf(recording().value.file, metadata(changes))).toThrow();
		},
	);
	it('rejects incomplete IQ pairs and multiple tuning segments', () => {
		expect(() => recordingFromSigmf(recording(3).value.file, metadata())).toThrow('pairs');
		const multiple = JSON.parse(metadata());
		multiple.captures.push({ 'core:sample_start': 100, 'core:frequency': 226000000 });
		expect(() => recordingFromSigmf(recording().value.file, JSON.stringify(multiple))).toThrow('continuous');
	});
});
