import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamSamplesPerPacket, streamTransferSize } from '@/devices/limesdr/stream-pcm';
import { receiveTransferSize } from '@/radio/receive-transfer';
import { MockHackRF } from '@/worker/runtime/mock-hackrf';

const instances = vi.hoisted(() => []);
vi.mock('@/worker/runtime/wasm-init', () => ({
	FFT: class {
		fft = vi.fn((input, output) => output.fill(input[0]));
		set_smoothing_speed = vi.fn();
		free = vi.fn();
		constructor(size, window) {
			this.size = size;
			this.window = window;
			instances.push(this);
		}
	},
}));

import { SpectrumStream } from '@/worker/streams/spectrum-stream';

beforeEach(() => (instances.length = 0));
afterEach(() => vi.useRealTimers());

function createStream(size = 4, fps = 60) {
	const callback = vi.fn();
	const backend = { _spectrumFps: fps };
	const stream = new SpectrumStream(backend, size, callback);
	return { stream, backend, callback, fft: instances.at(-1) };
}

describe('rolling spectrum FFT', () => {
	it('waits for a full window then overlaps successive windows in chronological IQ order', () => {
		const { stream, fft, callback } = createStream();
		const windows = [];
		fft.fft.mockImplementation((input) => windows.push([...input]));
		stream.push(new Int8Array([0, 1, 2, 3]), 0);
		expect(callback).not.toHaveBeenCalled();
		stream.push(new Int8Array([4, 5, 6, 7]), 10);
		stream.push(new Int8Array([8, 9]), 30);
		stream.push(new Int8Array([10, 11, 12, 13, 14, 15]), 50);
		expect(windows).toEqual([
			[0, 1, 2, 3, 4, 5, 6, 7],
			[2, 3, 4, 5, 6, 7, 8, 9],
			[8, 9, 10, 11, 12, 13, 14, 15],
		]);
	});
	it('uses the latest complete window from oversized chunks and respects view offsets', () => {
		const { stream, fft } = createStream();
		const windows = [];
		fft.fft.mockImplementation((input) => windows.push([...input]));
		const input = new Int8Array([99, 99, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 99, 99]);
		stream.push(input.subarray(2, 14), 0);
		stream.push(new Int8Array([12, 13]), 20);
		expect(windows).toEqual([
			[4, 5, 6, 7, 8, 9, 10, 11],
			[6, 7, 8, 9, 10, 11, 12, 13],
		]);
	});
	it('does not emit duplicate frames when input stops and applies live rate changes', () => {
		const { stream, backend, callback } = createStream(4, 20);
		stream.push(new Int8Array(8), 0);
		stream.push(new Int8Array([1, 2]), 10);
		expect(callback).toHaveBeenCalledOnce();
		backend._spectrumFps = 60;
		stream.push(new Int8Array([3, 4]), 10);
		expect(callback).toHaveBeenCalledTimes(2);
		stream.push(new Int8Array(), 10000);
		expect(callback).toHaveBeenCalledTimes(2);
		stream.push(new Int8Array([5, 6]), 10000);
		expect(callback).toHaveBeenCalledTimes(3);
	});
	it('preserves the window and elapsed-time smoothing, copies remote frames before local transfer and frees replaced FFTs', () => {
		const { stream, backend, callback, fft } = createStream();
		const remote = (backend._remoteHostFftCb = vi.fn());
		callback.mockImplementation((frame) => structuredClone(frame, { transfer: [frame.buffer] }));
		stream.push(new Int8Array(8).fill(7), 0);
		stream.push(new Int8Array(2).fill(8), 25);
		expect(fft.window[0]).toBeCloseTo(0);
		expect(fft.window[2]).toBeCloseTo(1);
		expect(fft.set_smoothing_speed.mock.calls.at(-1)[0]).toBeCloseTo(1 - Math.sqrt(0.4));
		expect([...remote.mock.calls[0][0]]).toEqual([7, 7, 7, 7]);
		expect(remote.mock.invocationCallOrder[0]).toBeLessThan(callback.mock.invocationCallOrder[0]);
		new SpectrumStream(backend, 4, callback);
		expect(fft.free).toHaveBeenCalledOnce();
		backend._disposeSpectrum();
		expect(instances.at(-1).free).toHaveBeenCalledOnce();
	});
});

describe.each([false, true])('LimeSDR spectrum cadence (packed=%s)', (packed) => {
	it.each([1e6, 2e6, 5e6, 10e6, 61.44e6])('sustains the selected FPS at %i Sa/s with a 65536-point FFT', (rate) => {
		const samples = (streamTransferSize(packed, rate) / 4096) * streamSamplesPerPacket(packed);
		const interval = (samples * 1000) / rate;
		const chunk = new Int8Array(samples * 2);
		for (const fps of [20, 30, 60]) {
			const { stream, callback } = createStream(65536, fps);
			const times = [];
			let now;
			callback.mockImplementation(() => times.push(now));
			for (let index = 1; index * interval < 3000; index++) {
				now = index * interval;
				stream.push(chunk, now);
			}
			const steadyFrames = times.filter((time) => time >= 1000);
			expect(Math.abs(steadyFrames.length - fps * 2)).toBeLessThanOrEqual(1);
		}
	});
});

describe('spectrum cadence across receiver formats', () => {
	it.each([
		['HackRF', 2e6, 262144, 2],
		['RTL-SDR', 250000, 65536, 2],
		['Airspy', 2.5e6, 262144, 4],
		['Airspy HF+', 192000, 65536, 8],
		['Airspy HF+', 912000, 65536, 8],
	])('sustains 60 FPS on %s at %i Sa/s without reducing the FFT size', (_, rate, maximum, sampleBytes) => {
		const samples = receiveTransferSize(rate, maximum, sampleBytes) / sampleBytes;
		const interval = (samples * 1000) / rate;
		const chunk = new Int8Array(samples * 2);
		const { stream, callback } = createStream(65536, 60);
		const times = [];
		let now;
		callback.mockImplementation(() => times.push(now));
		for (let index = 1; index * interval < 3000; index++) {
			now = index * interval;
			stream.push(chunk, now);
		}
		expect(Math.abs(times.filter((time) => time >= 1000).length - 120)).toBeLessThanOrEqual(1);
	});
	it('feeds a real simulated receiver through the rolling FFT at its lowest supported rate', async () => {
		vi.useFakeTimers();
		const receiver = new MockHackRF();
		await receiver.setSampleRate(2e6);
		const { stream, callback } = createStream(65536, 60);
		const times = [];
		let samples = 0;
		callback.mockImplementation(() => times.push(performance.now()));
		await receiver.startRx((data) => {
			samples += data.byteLength / 2;
			stream.push(new Int8Array(data.buffer, data.byteOffset, data.byteLength));
		});
		vi.advanceTimersByTime(3000);
		await receiver.stopRx();
		expect(samples).toBe(6e6);
		expect(times.filter((time) => time >= 1000 && time < 3000)).toHaveLength(120);
	});
});
