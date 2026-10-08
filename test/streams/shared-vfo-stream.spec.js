import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/client/worker/runtime/wasm-init', () => ({
	FFT: class {
		set_smoothing_speed() {}
		fft() {}
	},
}));

import { startRxStream } from '../../src/client/worker/streams/rx-stream';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function createStream(rdsCallback = null, dsdStatusCallback = null, rtl433Callback = null) {
	vi.useFakeTimers();
	const workers = [];
	vi.stubGlobal(
		'Worker',
		class {
			messages = [];
			terminate = vi.fn();
			constructor() {
				workers.push(this);
			}
			postMessage(message) {
				this.messages.push(message);
			}
		},
	);
	let receive;
	const backend = {
		device: {
			setSampleRate: vi.fn(),
			setFrequency: vi.fn(),
			startRx: async (callback) => {
				receive = callback;
			},
		},
		setSpectrumFps(value) {
			this._spectrumFps = value;
		},
		setWhisperEnabled(value) {
			this._whisperEnabled = value;
		},
		_reinitRemoteClientWorkers: vi.fn(),
	};
	await startRxStream(
		backend,
		{ centerFreq: 95, sampleRate: 61440000, fftSize: 65536 },
		null,
		null,
		null,
		null,
		rdsCallback,
		dsdStatusCallback,
		rtl433Callback,
	);
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
	it.each([false, true])('feeds muted sensor VFOs through shared DSP %s', async (shared) => {
		const received = vi.fn();
		const { backend, workers, receive } = await createStream(null, null, received);
		backend._sharedChannelization = shared;
		backend.vfoParams.forEach((params) => {
			params.enabled = false;
			params.rtl433 = true;
			params.rtl433SampleRate = 250000;
		});
		receive();
		if (shared) {
			const channelWorker = workers[3];
			const request = channelWorker.messages[0];
			channelWorker.onmessage({
				data: {
					type: 'bands',
					key: request.key,
					chunkId: request.chunkId,
					inputSamples: request.inputSamples,
					bands: [{ centerBin: request.centers[0], buffer: new ArrayBuffer(128), length: 32 }],
				},
			});
		}
		backend.dspWorkers.forEach((worker) => {
			expect(worker.messages.at(-1)).toMatchObject({
				type: 'process',
				params: { enabled: false, rtl433: true },
				sampleRate: shared ? 1920000 : 61440000,
			});
		});
		const event = { type: 'rtl433_event', freq: 95, event: { model: 'Weather' } };
		backend.dspWorkers[0].onmessage({ data: event });
		expect(received).toHaveBeenCalledWith(0, 95, event);
	});
	it('routes sensor events to the current VFO and discards stale events and status', async () => {
		const received = vi.fn();
		const { backend } = await createStream(null, null, received);
		const removed = backend.dspWorkers.shift();
		backend.vfoParams.shift();
		backend.vfoStates.shift();
		backend.vfoParams[0].rtl433 = true;
		const worker = backend.dspWorkers[0];
		const event = { type: 'rtl433_event', freq: 95.1, event: { model: 'Weather' } };
		worker.onmessage({ data: event });
		expect(received).toHaveBeenLastCalledWith(0, 95.1, event);
		backend.vfoParams[0].freq = 95.3;
		worker.onmessage({ data: event });
		worker.onmessage({ data: { type: 'rtl433_status', freq: 95.1, status: { state: 'receiving' } } });
		removed.onmessage({ data: event });
		expect(received).toHaveBeenCalledOnce();
		backend.vfoParams[0].rtl433 = false;
		worker.onmessage({ data: { ...event, freq: 95.3 } });
		const off = { type: 'rtl433_status', freq: 95.3, status: { state: 'off' } };
		worker.onmessage({ data: off });
		expect(received).toHaveBeenLastCalledWith(0, 95.3, off);
		expect(received).toHaveBeenCalledTimes(2);
	});
	it('routes DSD status and RDS separately after an earlier VFO is removed', async () => {
		const rdsCallback = vi.fn();
		const dsdStatusCallback = vi.fn();
		const { backend } = await createStream(rdsCallback, dsdStatusCallback);
		const removed = backend.dspWorkers.shift();
		backend.vfoParams.shift();
		backend.vfoStates.shift();
		const status = { mode: 'dmr', synced: true };
		backend.dspWorkers[0].onmessage({ data: { type: 'dsd_status', status } });
		expect(dsdStatusCallback).toHaveBeenCalledWith(0, status);
		expect(rdsCallback).not.toHaveBeenCalled();
		backend.dspWorkers[1].onmessage({ data: { type: 'rds', msg: { ps: 'STATION' } } });
		expect(rdsCallback).toHaveBeenCalledWith(1, 95.2, { ps: 'STATION' });
		removed.onmessage({ data: { type: 'dsd_status', status } });
		expect(dsdStatusCallback).toHaveBeenCalledOnce();
	});
	it('shares remote-client bands independently of the host and other clients', async () => {
		const { backend, workers, receive } = await createStream();
		const createWorker = (params) => backend._spawnWorker(0, params);
		const params = backend.vfoParams.map((value) => ({ ...value }));
		const alice = { sharedChannelization: true, params, workers: params.map(createWorker) };
		const bob = { params: [params[0]], workers: [createWorker(params[0])] };
		alice.perf = { audioCalls: 2, audioSamplesOut: 960, dspTimeSum: 4, dspTimeMax: 3, msgsSent: 1 };
		const statsCallback = vi.fn();
		backend._remoteHostStatsCb = statsCallback;
		backend._remoteClients = new Map([
			['alice', alice],
			['bob', bob],
		]);
		backend._sharedChannelization = false;
		receive();
		const channelWorker = workers.at(-1);
		const request = channelWorker.messages[0];
		channelWorker.onmessage({
			data: {
				type: 'bands',
				key: request.key,
				chunkId: request.chunkId,
				inputSamples: request.inputSamples,
				dspTime: 1,
				bands: [{ centerBin: request.centers[0], buffer: new ArrayBuffer(128), length: 32 }],
			},
		});
		alice.workers.forEach((worker) => expect(worker.messages.at(-1)).toMatchObject({ floatIq: true, sampleRate: 1920000 }));
		vi.advanceTimersByTime(500);
		const report = statsCallback.mock.calls.find(([id]) => id === 'alice')[1];
		expect(report).toMatchObject({
			source: 'host',
			dspAvgMs: '2.00',
			dspMaxMs: '3.00',
			channelization: { bands: 1, vfos: 3, sampleRate: 1920000 },
		});
		expect(report.audioRate).toBeGreaterThan(0);
		expect(report.inputRate).toBeGreaterThan(0);
		expect(alice.perf.audioCalls).toBe(0);
		[...backend.dspWorkers, ...bob.workers].forEach((worker) => {
			expect(worker.messages.at(-1).sampleRate).toBe(61440000);
			expect(worker.messages.at(-1).floatIq).toBeUndefined();
		});
		alice.sharedChannelization = false;
		receive();
		expect(channelWorker.terminate).toHaveBeenCalledOnce();
		alice.workers.forEach((worker) => expect(worker.messages.at(-1).sampleRate).toBe(61440000));
	});
	it.each([false, true])('routes muted RDS VFOs through shared DSP %s', async (shared) => {
		const rdsCallback = vi.fn();
		const { backend, workers, receive } = await createStream(rdsCallback);
		backend._sharedChannelization = shared;
		backend.vfoParams.forEach((params) => {
			params.enabled = false;
			params.rds = true;
		});
		receive();
		if (shared) {
			const channelWorker = workers[3];
			const request = channelWorker.messages[0];
			channelWorker.onmessage({
				data: {
					type: 'bands',
					key: request.key,
					chunkId: request.chunkId,
					inputSamples: request.inputSamples,
					dspTime: 1,
					bands: [{ centerBin: request.centers[0], buffer: new ArrayBuffer(128), length: 32 }],
				},
			});
		}
		backend.dspWorkers.forEach((worker) => {
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
		channelWorker.onmessage({
			data: {
				type: 'bands',
				key: request.key,
				chunkId: request.chunkId,
				inputSamples: request.inputSamples,
				dspTime: 1,
				bands: [{ centerBin: request.centers[0], buffer, length: 32 }],
			},
		});
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
		channelWorker.onmessage({
			data: {
				type: 'bands',
				key: request.key,
				inputSamples: request.inputSamples,
				dspTime: 1,
				bands: [{ centerBin: request.centers[0], buffer: new ArrayBuffer(128), length: 32 }],
			},
		});
		backend.dspWorkers.forEach((worker) => expect(worker.messages).toHaveLength(1));
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
