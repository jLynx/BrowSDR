import { afterEach, describe, expect, it, vi } from 'vitest';
import * as remoteHost from '@/worker/streams/remote-clients';
import { feedRemoteIqChunk, setRemoteIqEnabled, setRemoteIqVfoParams } from '@/remote/iq/client';
import { packIqPacket, unpackIqPacket } from '@/remote/iq/packet';
import { IqDispatcher } from '@/worker/streams/iq-dispatch';
import { dispatchIqChunk } from '@/worker/streams/channel-dispatch';
import { WebRTCHandler } from '@/remote/webrtc';

vi.mock('@/worker/runtime/wasm-init', () => ({ ensureWasmInitialized: vi.fn(), init: vi.fn() }));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
class MockWorker extends EventTarget {
	messages = [];
	terminate = vi.fn();
	postMessage(message) {
		this.messages.push(message);
	}
	complete(chunkId) {
		this.dispatchEvent(new MessageEvent('message', { data: { type: 'processed', chunkId } }));
	}
}
const params = { freq: 100, mode: 'nfm', bandwidth: 12500, enabled: true };
function packet(sequence, index = 0, revision = 1, discontinuity = false) {
	return packIqPacket({
		centerFreq: 100,
		sampleRate: 50000,
		bandwidth: 12500,
		bits: 8,
		scale: 0.002,
		index,
		revision,
		sequence,
		samples: new Int8Array([12, -12, 0, 1]),
		fullBand: false,
		discontinuity,
	});
}
function host() {
	vi.stubGlobal('Worker', MockWorker);
	const backend = { _sampleRate: 20e6, _centerFreq: 100, sharedIqPools: [new SharedArrayBuffer(32)], _remoteHostIqCb: vi.fn() };
	for (const [name, method] of Object.entries(remoteHost)) backend[name] = method.bind(backend);
	return backend;
}
function client() {
	const backend = {
		_remoteIqEnabled: true,
		_remoteClientCb: vi.fn(),
		_remoteIqRevisions: [1, 2],
		_remoteIqSequences: new Map(),
		vfoParams: [{ ...params }, { ...params, freq: 100.1 }],
		vfoStates: [{}, {}],
		dspWorkers: [new MockWorker(), new MockWorker()],
		_iqDispatcher: new IqDispatcher([]),
		_makeVfoState: () => ({ audioQueueLen: 0 }),
		_spawnWorker: vi.fn(() => new MockWorker()),
		_perf: { droppedChunks: 0, usbCallbacks: 0, inputSamplesSum: 0 },
		setVfoParams(index, value) {
			Object.assign(this.vfoParams[index], value);
		},
	};
	return backend;
}

describe('remote IQ lifecycle and routing', () => {
	it('counts complex IQ samples before the worker transfer detaches their buffer', () => {
		const backend = client();
		const worker = backend.dspWorkers[0];
		vi.spyOn(worker, 'postMessage').mockImplementation((message, transfer) => {
			worker.messages.push(structuredClone(message, { transfer }));
			expect(message.chunk.byteLength).toBe(0);
		});
		feedRemoteIqChunk.call(backend, packet(0));
		feedRemoteIqChunk.call(backend, packet(1));
		feedRemoteIqChunk.call(backend, packet(1));
		expect(backend._perf).toMatchObject({ usbCallbacks: 2, inputSamplesSum: 4, lastChunkSize: 4 });
		expect(new Float32Array(worker.messages[0].chunk)).toHaveLength(4);
		expect(worker.messages[0].preserveDc).toBe(true);
	});
	it('feeds independent client workers, rejects stale/reordered packets, and bounds pending decoding', () => {
		const backend = client();
		feedRemoteIqChunk.call(backend, packet(0));
		feedRemoteIqChunk.call(backend, packet(0, 1, 2));
		feedRemoteIqChunk.call(backend, packet(1));
		expect(backend.dspWorkers[0].messages.map((m) => m.chunkId)).toEqual([0, 1]);
		expect(backend.dspWorkers[1].messages.map((m) => m.chunkId)).toEqual([0]);
		expect([...new Float32Array(backend.dspWorkers[0].messages[0].chunk)]).toEqual(
			expect.arrayContaining([expect.closeTo(0.024, 6), expect.closeTo(-0.024, 6)]),
		);
		feedRemoteIqChunk.call(backend, packet(0));
		feedRemoteIqChunk.call(backend, packet(1));
		feedRemoteIqChunk.call(backend, packet(2, 0, 99));
		expect(backend.dspWorkers[0].messages).toHaveLength(2);
		for (let i = 2; i < 10; i++) feedRemoteIqChunk.call(backend, packet(i));
		expect(backend.dspWorkers[0].messages).toHaveLength(8);
		expect(backend._perf.droppedChunks).toBe(2);
		for (let i = 0; i < 8; i++) backend.dspWorkers[0].complete(i);
		feedRemoteIqChunk.call(backend, packet(10));
		expect(backend.dspWorkers[0].messages.at(-1).discontinuity).toBe(true);
		expect(backend._spawnWorker).not.toHaveBeenCalled();
		backend._remoteClientCb = null;
		feedRemoteIqChunk.call(backend, packet(11));
		expect(backend.dspWorkers[0].messages.at(-1).sequence).toBe(10);
	});
	it('invalidates old VFO revisions and clears processing when switching decoding mode', () => {
		const backend = client();
		const old = backend.dspWorkers[0];
		setRemoteIqVfoParams.call(backend, 0, { ...params, freq: 100.2 }, 3);
		expect(old.terminate).toHaveBeenCalledOnce();
		feedRemoteIqChunk.call(backend, packet(1));
		expect(backend.dspWorkers[0].messages).toHaveLength(0);
		feedRemoteIqChunk.call(backend, packet(2, 0, 3));
		expect(backend.dspWorkers[0].messages).toHaveLength(1);
		setRemoteIqVfoParams.call(backend, 0, { ...params, volume: 25 }, 3);
		expect(backend._spawnWorker).toHaveBeenCalledTimes(1);
		setRemoteIqEnabled.call(backend, false);
		expect(backend._remoteIqSequences.size).toBe(0);
		feedRemoteIqChunk.call(backend, packet(3, 0, 3));
		expect(backend.dspWorkers[0].messages).toHaveLength(0);
	});
	it('supports mixed audio/IQ clients and drops results from removed, reindexed or restarted host workers', async () => {
		const backend = host();
		for (const id of ['alice', 'bob']) {
			await backend.addRemoteClient(id);
			await backend.setRemoteVfoParams(id, 0, params, 1);
		}
		backend.configureRemoteStream('alice', 'iq', 8);
		await backend.addRemoteVfo('alice');
		await backend.setRemoteVfoParams('alice', 1, { ...params, freq: 100.1 }, 2);
		const alice = backend._remoteClients.get('alice');
		const worker = alice.workers[1];
		expect(worker.messages[0].extractOnly).toBe(true);
		expect(backend._remoteClients.get('bob').workers[0].messages[0].extractOnly).toBe(false);
		const emit = (worker, index = 1, revision = 2) =>
			worker.onmessage({ data: { type: 'iq_slice', index, revision, packets: [packet(0, index, revision)] } });
		emit(worker);
		expect(unpackIqPacket(backend._remoteHostIqCb.mock.calls.at(-1)[1]).sequence).toBe(0);
		backend._reinitRemoteClientWorkers();
		emit(worker);
		expect(backend._remoteHostIqCb).toHaveBeenCalledTimes(1);
		const current = alice.workers[1];
		emit(current);
		expect(unpackIqPacket(backend._remoteHostIqCb.mock.calls.at(-1)[1]).sequence).toBe(1);
		await backend.removeRemoteVfo('alice', 0);
		emit(current);
		expect(backend._remoteHostIqCb).toHaveBeenCalledTimes(2);
		emit(current, 0);
		expect(unpackIqPacket(backend._remoteHostIqCb.mock.calls.at(-1)[1]).index).toBe(0);
		backend.configureRemoteStream('alice', 'audio', 16);
		emit(current, 0);
		expect(backend._remoteHostIqCb).toHaveBeenCalledTimes(3);
		expect(alice.workers[0].messages[0].extractOnly).toBe(false);
	});
	it.each([8, 16])('forces IQ8 for a %s-bit request while retaining 16-bit capture and legacy host decoding', async (bits) => {
		const backend = host();
		for (const id of ['alice', 'bob']) {
			await backend.addRemoteClient(id);
			await backend.setRemoteVfoParams(id, 0, params, 1);
		}
		backend.configureRemoteStream('alice', 'iq', bits);
		const localWorker = new MockWorker();
		Object.assign(backend, {
			dspWorkers: [localWorker],
			vfoParams: [params],
			_sharedChannelization: false,
			iqCapture: { push: vi.fn() },
			_iqDispatcher: new IqDispatcher([new Int8Array(32)]),
		});
		const perf = { droppedChunks: 0 };
		dispatchIqChunk(backend, 20e6, 100, {}, perf, new Int16Array(16), 1);
		const alice = backend._remoteClients.get('alice').workers[0].messages.at(-1);
		const bob = backend._remoteClients.get('bob').workers[0].messages.at(-1);
		expect(alice.slice).toMatchObject({ index: 0, revision: 1, bits: 8, sampleRate: 50000, centerFreq: 100 });
		expect(alice.iqFormat).toBe('int16');
		expect(bob.slice).toBeUndefined();
		expect(bob.iqFormat).toBe('int16');
		expect(localWorker.messages.at(-1)).toMatchObject({ iqFormat: 'int16', slice: undefined });
		const worker = backend._remoteClients.get('alice').workers[0];
		backend.configureRemoteStream('alice', 'iq', 16);
		expect(backend._remoteClients.get('alice').workers[0]).toBe(worker);
		expect(perf.droppedChunks).toBe(0);
	});
});

describe('IQ network backpressure', () => {
	it('budgets all active receiver/VFO streams together and stops feeding a stalled PeerJS queue', () => {
		const transport = new WebRTCHandler(true);
		const audio = { open: true, send: vi.fn(), dataChannel: { bufferedAmount: 0 }, bufferSize: 0 };
		transport.clients.set('alice', { audio });
		transport.sendIqChunkTo('alice', packet(0), 100000, 'lime:0');
		transport.sendIqChunkTo('alice', packet(0), 100000, 'hackrf:0');
		audio.dataChannel.bufferedAmount = 30000;
		transport.sendIqChunkTo('alice', packet(1), 100000, 'lime:0');
		expect(audio.send).toHaveBeenCalledTimes(3);
		audio.dataChannel.bufferedAmount = 50000;
		transport.sendIqChunkTo('alice', packet(2), 100000, 'lime:0');
		expect(audio.send).toHaveBeenCalledTimes(3);
		audio.dataChannel.bufferedAmount = 0;
		audio.bufferSize = 1;
		transport.sendIqChunkTo('alice', packet(3), 100000, 'lime:0');
		expect(audio.send).toHaveBeenCalledTimes(3);
	});
});
