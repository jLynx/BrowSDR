import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/client/worker/wasm-init', () => ({
	FFT: class {
		set_smoothing_speed() {}
	},
}));

import { startRxStream } from '../src/client/worker/rx-stream';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function createStream(vfoCount = 1) {
	vi.useFakeTimers();
	vi.stubGlobal('Worker', class {
		postMessage() {}
	});
	const audio = vi.fn();
	const whisper = vi.fn();
	const backend = {
		device: { setSampleRate: vi.fn(), setFrequency: vi.fn(), startRx: vi.fn() },
		setSpectrumFps: vi.fn(),
		_reinitRemoteClientWorkers: vi.fn(),
	};
	await startRxStream(backend, { centerFreq: 95, sampleRate: 61440000, fftSize: 65536 }, null, audio, whisper, null);
	for (let index = 1; index < vfoCount; index++) {
		backend.vfoParams.push({ ...backend.vfoParams[0], freq: 89 + index / 10 });
		backend.vfoStates.push(backend._makeVfoState());
	}
	backend.vfoParams.forEach(params => { params.enabled = true; });
	const feed = (index, size) => backend._handleWorkerAudio(index, {
		samples: new Float32Array(size).fill(0.01).buffer,
		squelchOpen: false, squelchDb: -50, dspTime: 0.5,
	});
	return { backend, audio, whisper, feed };
}

describe('RX audio delivery batching', () => {
	it('batches small mixer outputs into a 50 ms delivery', async () => {
		const { backend, audio, feed } = await createStream();
		for (let chunk = 0; chunk < 47; chunk++) feed(0, 51);
		expect(audio).not.toHaveBeenCalled();
		feed(0, 51);
		expect(audio).toHaveBeenCalledTimes(1);
		expect(audio.mock.calls[0][0].length).toBe(2448);
		expect(backend._perf.msgsSent).toBe(1);
	});
	it('batches isolated transcription audio for all nineteen VFOs', async () => {
		const { backend, audio, whisper, feed } = await createStream(19);
		for (let chunk = 0; chunk < 48; chunk++) {
			for (let index = 0; index < 19; index++) feed(index, 51);
		}
		expect(audio).toHaveBeenCalledTimes(1);
		expect(whisper).toHaveBeenCalledTimes(19);
		whisper.mock.calls.forEach(([index, freq, samples]) => {
			expect(freq).toBe(backend.vfoParams[index].freq);
			expect(samples.length).toBe(2448);
			expect(samples[0]).toBeCloseTo(0.01);
		});
		expect(audio.mock.calls[0][0][0]).toBeCloseTo(19 * 0.01 * 0.25);
	});
	it('delivers large low-callback-rate audio blocks immediately', async () => {
		const { audio, feed } = await createStream();
		feed(0, 4800);
		expect(audio).toHaveBeenCalledTimes(1);
		expect(audio.mock.calls[0][0].length).toBe(4800);
	});
	it('does not forward a muted VFO into the mixer or transcription', async () => {
		const { backend, audio, whisper, feed } = await createStream();
		backend.vfoParams[0].enabled = false;
		backend.vfoParams[0].rds = true;
		feed(0, 4800);
		expect(audio).not.toHaveBeenCalled();
		expect(whisper).not.toHaveBeenCalled();
	});
});
