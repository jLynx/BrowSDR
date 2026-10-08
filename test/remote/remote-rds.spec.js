import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/worker/runtime/wasm-init', () => ({ ensureWasmInitialized: vi.fn(), init: vi.fn() }));
vi.mock('@/remote/webrtc', () => ({
	PEER_ID_PREFIX: 'test-',
	WebRTCHandler: class {
		init = vi.fn();
		sendCommandTo = vi.fn();
		sendAudioChunkTo = vi.fn();
	},
}));

import * as remoteBackend from '@/worker/streams/remote-clients';
import { remoteMethods } from '@/app/workspace/remote';
import { rdsMethods } from '@/app/decoders/rds';
import { rtl433Methods } from '@/app/decoders/rtl433';
import { AUDIO_QUEUE_CAPACITY } from '@/worker/streams/audio-queue';

afterEach(() => {
	vi.unstubAllGlobals();
});

const params = { freq: 106.2, mode: 'wfm', enabled: false, rds: true, rdsRegion: 'eu', bandwidth: 150000, volume: 50 };

function makeBackend() {
	vi.stubGlobal(
		'Worker',
		class {
			messages = [];
			terminate = vi.fn();
			postMessage(message) {
				this.messages.push(message);
			}
		},
	);
	const backend = { _sampleRate: 2000000, _centerFreq: 106.2, sharedIqPools: [new ArrayBuffer(32)] };
	for (const [name, method] of Object.entries(remoteBackend)) backend[name] = method.bind(backend);
	return backend;
}

function makeClient(frequency = 106.2) {
	const client = {
		remoteMode: 'client',
		vfos: [{ ...params, freq: frequency }],
		rds: { stations: {}, log: [] },
		$refs: {},
		$nextTick: (callback) => callback(),
		formatFreq: (value) => value.toFixed(6),
	};
	Object.assign(client, rdsMethods);
	return client;
}

describe('remote RDS delivery', () => {
	it('forwards muted sensor events and status only to the matching remote client', async () => {
		vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
		vi.stubGlobal('localStorage', { getItem: () => null });
		const backend = makeBackend();
		const host = { connected: true, running: true, remoteMode: 'none', locks: {}, backend, radio: {}, gains: {} };
		await remoteMethods.startRemoteHost.call(host);
		const sensor = { ...params, freq: 433.92, mode: 'nfm', rds: false, rtl433: true };
		const listeners = Object.fromEntries(
			['alice', 'bob'].map((id) => [
				id,
				{
					running: true,
					remoteMode: 'client',
					vfos: [{ ...sensor }],
					rtl433: { log: [], status: [], protocols: [] },
					formatFreq: String,
					$refs: {},
					$nextTick: (callback) => callback(),
					...rtl433Methods,
				},
			]),
		);
		host._webrtc.sendCommandTo.mockImplementation((id, command) =>
			remoteMethods.handleRemoteCommand.call(listeners[id], JSON.parse(JSON.stringify(command))),
		);
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, sensor);
		await backend.addRemoteClient('bob');
		await backend.setRemoteVfoParams('bob', 0, sensor);
		const worker = backend._remoteClients.get('alice').workers[0];
		const event = { type: 'rtl433_event', freq: sensor.freq, event: { model: 'Weather', temperature_C: 20 } };
		worker.onmessage({ data: event });
		worker.onmessage({ data: { type: 'rtl433_status', freq: sensor.freq, status: { state: 'receiving', samples: 250000 } } });
		expect(listeners.alice.rtl433.log[0].event).toEqual(event.event);
		expect(listeners.alice.rtl433.status[0]).toMatchObject({ state: 'receiving', samples: 250000 });
		expect(listeners.bob.rtl433.log).toEqual([]);
		const hostMessage = vi.fn();
		remoteMethods.handleRemoteCommand.call({ remoteMode: 'host', _onRtl433Message: hostMessage }, 'alice', {
			type: 'rtl433',
			vfoIndex: 0,
			freq: sensor.freq,
			msg: event,
		});
		expect(hostMessage).not.toHaveBeenCalled();
	});
	it('discards remote sensor messages after retuning, VFO removal, restart or disconnection', async () => {
		const backend = makeBackend();
		const received = vi.fn();
		await backend.setRemoteHostRtl433Callback(received);
		const sensor = { ...params, freq: 433.92, rtl433: true };
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, sensor);
		await backend.addRemoteVfo('alice');
		await backend.setRemoteVfoParams('alice', 1, sensor);
		const state = backend._remoteClients.get('alice');
		const removed = state.workers[0];
		const survivor = state.workers[1];
		await backend.removeRemoteVfo('alice', 0);
		const event = { type: 'rtl433_event', freq: sensor.freq, event: { model: 'Weather' } };
		survivor.onmessage({ data: event });
		expect(received).toHaveBeenLastCalledWith('alice', 0, sensor.freq, event);
		await backend.setRemoteVfoParams('alice', 0, { ...sensor, freq: 434 });
		survivor.onmessage({ data: event });
		survivor.onmessage({ data: { type: 'rtl433_status', freq: sensor.freq, status: { state: 'receiving' } } });
		removed.onmessage({ data: event });
		expect(received).toHaveBeenCalledOnce();
		backend._reinitRemoteClientWorkers();
		const restarted = state.workers[0];
		survivor.onmessage({ data: { ...event, freq: 434 } });
		await backend.setRemoteVfoParams('alice', 0, { ...sensor, freq: 434, rtl433: false });
		restarted.onmessage({ data: { ...event, freq: 434 } });
		expect(received).toHaveBeenCalledOnce();
		const off = { type: 'rtl433_status', freq: 434, status: { state: 'off' } };
		restarted.onmessage({ data: off });
		expect(received).toHaveBeenLastCalledWith('alice', 0, 434, off);
		await backend.removeRemoteClient('alice');
		restarted.onmessage({ data: off });
		expect(received).toHaveBeenCalledTimes(2);
	});
	it('records remote DSP time and audio output and forwards reports to the correct client', async () => {
		vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
		vi.stubGlobal('localStorage', { getItem: () => null });
		const backend = makeBackend();
		backend._perf = { audioCalls: 0, audioSamplesOut: 0, dspTimeSum: 0, dspTimeMax: 0 };
		const host = { connected: true, running: true, remoteMode: 'none', locks: {}, backend, radio: {}, gains: {} };
		await remoteMethods.startRemoteHost.call(host);
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, { ...params, enabled: true });
		const state = backend._remoteClients.get('alice');
		state.workers[0].onmessage({ data: { type: 'audio', samples: new Float32Array(4800).buffer, dspTime: 2 } });
		expect(state.perf).toMatchObject({ audioCalls: 1, audioSamplesOut: 4800, dspTimeSum: 2, dspTimeMax: 2, msgsSent: 1 });
		expect(backend._perf).toMatchObject({ audioCalls: 1, audioSamplesOut: 4800, dspTimeSum: 2, dspTimeMax: 2 });
		const client = { remoteMode: 'client', dspStats: null };
		host._webrtc.sendCommandTo.mockImplementation((id, command) => {
			expect(id).toBe('alice');
			remoteMethods.handleRemoteCommand.call(client, JSON.parse(JSON.stringify(command)));
		});
		const stats = { source: 'host', dspAvgMs: '2.00', inputRate: 61440000, channelization: { bands: 1, vfos: 3, sampleRate: 1920000 } };
		backend._remoteHostStatsCb('alice', stats);
		expect(client.dspStats).toEqual(stats);
		remoteMethods.handleRemoteCommand.call(host, 'alice', { type: 'dspStats', stats: { inputRate: 0 } });
		expect(host.dspStats).toBeUndefined();
	});
	it('sends a remote DSP preference only for the requesting client and leaves host settings alone', async () => {
		const backend = makeBackend();
		await backend.addRemoteClient('alice');
		await backend.addRemoteClient('bob');
		backend._sharedChannelization = false;
		const host = { remoteMode: 'host', backend, locks: { centerFreq: true }, display: { sharedChannelization: false } };
		const client = { remoteMode: 'client', display: { sharedChannelization: true }, _webrtc: { sendCommand: vi.fn() } };
		remoteMethods.applySharedChannelization.call(client);
		const command = client._webrtc.sendCommand.mock.calls[0][0];
		remoteMethods.handleRemoteCommand.call(host, 'alice', command);
		expect(backend._remoteClients.get('alice').sharedChannelization).toBe(true);
		expect(backend._remoteClients.get('bob').sharedChannelization).toBeUndefined();
		expect(host.display.sharedChannelization).toBe(false);
		expect(backend._sharedChannelization).toBe(false);
		remoteMethods.handleRemoteCommand.call(host, 'alice', { ...command, sharedChannelization: false });
		expect(backend._remoteClients.get('alice').sharedChannelization).toBe(false);
		remoteMethods.handleRemoteCommand.call(host, 'alice', { ...command, sharedChannelization: 'false' });
		expect(backend._remoteClients.get('alice').sharedChannelization).toBe(false);
		remoteMethods.handleRemoteCommand.call(host, 'unknown', command);
		expect(backend._remoteClients.size).toBe(2);
	});
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
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, params);
		await backend.addRemoteClient('bob');
		await backend.setRemoteVfoParams('bob', 0, { ...params, freq: 98.9 });
		const worker = backend._remoteClients.get('alice').workers[0];
		for (const message of [{ pi: '9240' }, { ps: 'channelX' }, { rt: 'Madness - Our House' }]) {
			worker.onmessage({ data: { type: 'rds', msg: message } });
		}
		expect(host._webrtc.sendCommandTo).toHaveBeenLastCalledWith('alice', {
			type: 'rds',
			vfoIndex: 0,
			freq: 106.2,
			msg: { rt: 'Madness - Our House' },
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
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, params);
		await backend.addRemoteVfo('alice');
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
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, params);
		const state = backend._remoteClients.get('alice');
		const event = { data: { type: 'audio', samples: new Float32Array(4800).fill(0.1).buffer } };
		for (let count = 0; count < 100; count++) state.workers[0].onmessage(event);
		expect(state.audioQueues[0].len).toBe(0);
		expect(state.audioQueues[0].queue.length).toBe(AUDIO_QUEUE_CAPACITY);
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
	it('bounds remote audio and continues playback when a decoder stops responding', async () => {
		const backend = makeBackend();
		const audio = vi.fn();
		await backend.setRemoteHostAudioCallback(audio);
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, { ...params, enabled: true });
		await backend.addRemoteVfo('alice');
		await backend.setRemoteVfoParams('alice', 1, { ...params, freq: 106.3, enabled: true });
		const state = backend._remoteClients.get('alice');
		const queue = state.audioQueues[0].queue;
		for (let i = 0; i < 100; i++) backend._queueRemoteAudio('alice', 0, new Float32Array(4800).fill(0.1));
		expect(audio).toHaveBeenCalled();
		expect(audio.mock.calls[0][1][0]).toBeCloseTo(0.025);
		expect(state.audioQueues[0].queue).toBe(queue);
		expect(queue.length).toBe(AUDIO_QUEUE_CAPACITY);
		expect(state.audioQueues[0].len).toBeLessThan(12000);
	});
	it('forwards remote transcription only when enabled', async () => {
		const backend = makeBackend();
		backend._remoteClientAudioCb = vi.fn();
		backend._remoteClientWhisperCb = vi.fn();
		backend.vfoParams = [params];
		const samples = new Float32Array(4800);
		await backend.feedRemoteAudioChunk(samples);
		expect(backend._remoteClientWhisperCb).not.toHaveBeenCalled();
		backend._whisperEnabled = true;
		await backend.feedRemoteAudioChunk(samples);
		expect(backend._remoteClientWhisperCb).toHaveBeenCalledWith(0, params.freq, samples);
		expect(backend._remoteClientAudioCb).toHaveBeenCalledTimes(2);
	});
	it('isolates only one remote client speaker mix without disabling its VFOs', async () => {
		const backend = makeBackend();
		const audio = vi.fn();
		await backend.setRemoteHostAudioCallback(audio);
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, { ...params, enabled: true, audioMuted: true });
		await backend.addRemoteVfo('alice');
		await backend.setRemoteVfoParams('alice', 1, { ...params, enabled: true, audioMuted: false });
		const samples = new Float32Array(4800).fill(0.1);
		backend._queueRemoteAudio('alice', 0, samples);
		backend._queueRemoteAudio('alice', 1, samples);
		expect(audio.mock.calls[0][1][0]).toBeCloseTo(0.025);
		expect(backend._remoteClients.get('alice').params.every((value) => value.enabled && value.volume === 50)).toBe(true);
	});
});
