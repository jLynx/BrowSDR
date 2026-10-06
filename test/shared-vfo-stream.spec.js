import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/client/worker/wasm-init', () => ({
	FFT: class {
		set_smoothing_speed() {}
		fft() {}
	},
}));

import { startRxStream } from '../src/client/worker/rx-stream';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function createStream(rdsCallback = null) {
	vi.useFakeTimers();
	const workers = [];
	vi.stubGlobal('Worker', class {
		messages = [];
		terminate = vi.fn();
		constructor() { workers.push(this); }
		postMessage(message) { this.messages.push(message); }
	});
	let receive;
	const backend = {
		device: { setSampleRate: vi.fn(), setFrequency: vi.fn(), startRx: async callback => { receive = callback; } },
		setSpectrumFps(value) { this._spectrumFps = value; },
		_reinitRemoteClientWorkers: vi.fn(),
	};
	await startRxStream(backend, { centerFreq: 95, sampleRate: 61440000, fftSize: 65536 }, null, null, null, null, rdsCallback);
	for (const freq of [95.1, 95.2]) {
		const params = { ...backend.vfoParams[0], freq, enabled: true };
		backend.vfoParams.push(params);
		backend.vfoStates.push(backend._makeVfoState());
		backend.dspWorkers.push(backend._spawnWorker(backend.vfoParams.length - 1, params));
	}
	backend.vfoParams[0].enabled = true;
	return { backend, workers, receive: () => receive(new Int8Array(130560)) };
}

describe('shared VFO worker routing', () => {
	it.each([false, true])('routes muted RDS VFOs through shared DSP %s', async shared => {
		const rdsCallback = vi.fn();
		const { backend, workers, receive } = await createStream(rdsCallback);
		backend._sharedChannelization = shared;
		backend.vfoParams.forEach(params => { params.enabled = false; params.rds = true; });
		receive();
		if (shared) {
			const channelWorker = workers[3];
			const request = channelWorker.messages[0];
			channelWorker.onmessage({ data: { type: 'bands', key: request.key, chunkId: request.chunkId, inputSamples: request.inputSamples, dspTime: 1,
				bands: [{ centerBin: request.centers[0], buffer: new ArrayBuffer(128), length: 32 }] } });
		}
		backend.dspWorkers.forEach(worker => {
			const request = worker.messages.at(-1);
			expect(request.type).toBe('process');
			expect(request.params.enabled).toBe(false);
			expect(request.params.rds).toBe(true);
		});
		backend.dspWorkers[0].onmessage({ data: { type: 'rds', msg: { rt: 'Muted station text' } } });
		expect(rdsCallback).toHaveBeenCalledWith(0, 95, { rt: 'Muted station text' });
	});
	it('routes RDS to the current VFO after an earlier VFO is removed', async () => {
		const rdsCallback = vi.fn();
		const { backend } = await createStream(rdsCallback);
		const removed = backend.dspWorkers.shift();
		backend.vfoParams.shift();
		backend.vfoStates.shift();
		const message = { ps: 'STATION' };
		backend.dspWorkers[0].onmessage({ data: { type: 'rds', msg: message } });
		expect(rdsCallback).toHaveBeenCalledWith(0, 95.1, message);
		removed.onmessage({ data: { type: 'rds', msg: message } });
		expect(rdsCallback).toHaveBeenCalledOnce();
	});
	it('multicasts immutable narrow IQ while retaining independent VFO parameters', async () => {
		const { backend, workers, receive } = await createStream();
		receive();
		const channelWorker = workers[3];
		const request = channelWorker.messages[0];
		expect(request.type).toBe('channelize');
		expect(request.sampleRate).toBe(1920000);
		expect(request.chunk.byteLength).toBe(130560);
		const buffer = new ArrayBuffer(128);
		channelWorker.onmessage({ data: { type: 'bands', key: request.key, chunkId: request.chunkId, inputSamples: request.inputSamples, dspTime: 1,
			bands: [{ centerBin: request.centers[0], buffer, length: 32 }] } });
		for (let index = 0; index < 3; index++) {
			const message = backend.dspWorkers[index].messages.at(-1);
			expect(message.floatIq).toBe(true);
			expect(message.chunk).toBe(buffer);
			expect(message.sampleRate).toBe(1920000);
			expect(message.params.freq).toBe(backend.vfoParams[index].freq);
		}
		backend._disposeChannelization();
		expect(channelWorker.terminate).toHaveBeenCalledOnce();
	});
	it('rejects stale bands after receiver retuning', async () => {
		const { backend, workers, receive } = await createStream();
		receive();
		const channelWorker = workers[3];
		const request = channelWorker.messages[0];
		backend._centerFreq = 95.1;
		receive();
		channelWorker.onmessage({ data: { type: 'bands', key: request.key, inputSamples: request.inputSamples, dspTime: 1,
			bands: [{ centerBin: request.centers[0], buffer: new ArrayBuffer(128), length: 32 }] } });
		backend.dspWorkers.forEach(worker => expect(worker.messages).toHaveLength(1));
	});
	it('switches live to direct DSP and terminates the shared worker', async () => {
		const { backend, workers, receive } = await createStream();
		receive();
		backend._sharedChannelization = false;
		receive();
		expect(workers[3].terminate).toHaveBeenCalledOnce();
		for (const worker of backend.dspWorkers) {
			const message = worker.messages.at(-1);
			expect(message.type).toBe('process');
			expect(message.sampleRate).toBe(61440000);
			expect(message.centerFreq).toBe(95);
			expect(message.floatIq).toBeUndefined();
		}
	});
	it('bounds the shared input backlog rather than accumulating indefinitely', async () => {
		const { backend, workers, receive } = await createStream();
		for (let index = 0; index < 200; index++) receive();
		expect(workers[3].messages.length).toBeLessThan(100);
		expect(backend._perf.droppedChunks).toBeGreaterThan(0);
	});
});
