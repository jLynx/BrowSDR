import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/client/worker/wasm-init', () => ({ ensureWasmInitialized: vi.fn(), init: vi.fn() }));
vi.mock('../src/client/webrtc', () => ({
	PEER_ID_PREFIX: 'test-',
	WebRTCHandler: class {
		init = vi.fn();
		sendCommandTo = vi.fn();
	},
}));

import * as remoteBackend from '../src/client/worker/remote-clients';
import { remoteMethods } from '../src/client/app/remote';
import { rdsMethods } from '../src/client/app/rds';

afterEach(() => { vi.unstubAllGlobals(); });

const params = { freq: 106.2, mode: 'wfm', enabled: false, rds: true, rdsRegion: 'eu', bandwidth: 150000, volume: 50 };

function makeBackend() {
	vi.stubGlobal('Worker', class {
		messages = [];
		terminate = vi.fn();
		postMessage(message) { this.messages.push(message); }
	});
	const backend = { _sampleRate: 2000000, _centerFreq: 106.2, sharedIqPools: [new ArrayBuffer(32)] };
	for (const [name, method] of Object.entries(remoteBackend)) backend[name] = method.bind(backend);
	return backend;
}

function makeClient(frequency = 106.2) {
	const client = {
		remoteMode: 'client', vfos: [{ ...params, freq: frequency }],
		rds: { stations: {}, log: [] }, $refs: {}, $nextTick: callback => callback(),
		formatFreq: value => value.toFixed(6),
	};
	Object.assign(client, rdsMethods);
	return client;
}

describe('remote RDS delivery', () => {
	it('forwards decoded metadata through host callbacks and serialized commands to the correct muted client', async () => {
		vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
		vi.stubGlobal('localStorage', { getItem: () => null });
		const backend = makeBackend();
		const host = { connected: true, running: true, remoteMode: 'none', locks: {}, backend, radio: {}, gains: {} };
		await remoteMethods.startRemoteHost.call(host);
		const listeners = { alice: makeClient(), bob: makeClient(98.9) };
		host._webrtc.sendCommandTo.mockImplementation((id, command) => {
			remoteMethods.handleRemoteCommand.call(listeners[id], JSON.parse(JSON.stringify(command)));
		});
		await backend.setRemoteVfoParams('alice', 0, params);
		await backend.setRemoteVfoParams('bob', 0, { ...params, freq: 98.9 });
		const worker = backend._remoteClients.get('alice').workers[0];
		for (const message of [{ pi: '9240' }, { ps: 'channelX' }, { rt: 'Madness - Our House' }]) {
			worker.onmessage({ data: { type: 'rds', msg: message } });
		}
		expect(host._webrtc.sendCommandTo).toHaveBeenLastCalledWith('alice', {
			type: 'rds', vfoIndex: 0, freq: 106.2, msg: { rt: 'Madness - Our House' },
		});
		expect(listeners.alice.rds.stations[0]).toMatchObject({ pi: '9240', ps: 'channelX', rt: 'Madness - Our House' });
		expect(listeners.bob.rds.stations).toEqual({});
		await backend.setRemoteVfoParams('alice', 0, { ...params, rdsRegion: 'na' });
		expect(worker.messages.at(-1).params.rdsRegion).toBe('na');
	});
	it('preserves forwarding across restarts and VFO removal and ignores obsolete workers', async () => {
		const backend = makeBackend();
		const received = vi.fn();
		await backend.setRemoteHostRdsCallback(received);
		await backend.setRemoteVfoParams('alice', 0, params);
		await backend.setRemoteVfoParams('alice', 1, { ...params, freq: 98.9 });
		const state = backend._remoteClients.get('alice');
		const removed = state.workers[0];
		const survivor = state.workers[1];
		await backend.removeRemoteVfo('alice', 0);
		const event = { data: { type: 'rds', msg: { ps: 'HAURAKI' } } };
		survivor.onmessage(event);
		expect(received).toHaveBeenLastCalledWith('alice', 0, 98.9, event.data.msg);
		backend._sampleRate = 4000000;
		backend._reinitRemoteClientWorkers();
		const restarted = state.workers[0];
		expect(restarted.messages[0].sampleRate).toBe(4000000);
		restarted.onmessage(event);
		expect(received).toHaveBeenCalledTimes(2);
		removed.onmessage(event);
		survivor.onmessage(event);
		expect(received).toHaveBeenCalledTimes(2);
		await backend.setRemoteVfoParams('alice', 0, { ...params, freq: 98.9, rds: false });
		restarted.onmessage(event);
		expect(received).toHaveBeenCalledTimes(2);
		await backend.removeRemoteClient('alice');
		restarted.onmessage(event);
		expect(received).toHaveBeenCalledTimes(2);
	});
	it('does not accumulate audio for muted remote RDS VFOs', async () => {
		const backend = makeBackend();
		const audio = vi.fn();
		await backend.setRemoteHostAudioCallback(audio);
		await backend.setRemoteVfoParams('alice', 0, params);
		const state = backend._remoteClients.get('alice');
		const event = { data: { type: 'audio', samples: new Float32Array(4800).fill(0.1).buffer } };
		for (let count = 0; count < 100; count++) state.workers[0].onmessage(event);
		expect(state.audioQueues[0].len).toBe(0);
		expect(state.audioQueues[0].queue.length).toBe(32768);
		expect(audio).not.toHaveBeenCalled();
		await backend.setRemoteVfoParams('alice', 0, { ...params, enabled: true });
		state.workers[0].onmessage(event);
		expect(audio).toHaveBeenCalledOnce();
	});
	it('rejects metadata for disabled decoding, a removed VFO, or an old tuned frequency', () => {
		const client = makeClient();
		const command = { type: 'rds', vfoIndex: 0, freq: 106.2, msg: { rt: 'Old station' } };
		client.vfos[0].freq = 98.9;
		remoteMethods.handleRemoteCommand.call(client, command);
		client.vfos[0].freq = 106.2;
		client.vfos[0].rds = false;
		remoteMethods.handleRemoteCommand.call(client, command);
		client.vfos.length = 0;
		remoteMethods.handleRemoteCommand.call(client, command);
		expect(client.rds.stations).toEqual({});
	});
});
