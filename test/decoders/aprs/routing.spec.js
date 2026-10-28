import { afterEach, describe, expect, it, vi } from 'vitest';
import * as remoteBackend from '@/worker/streams/remote-clients';
import { routeLocalWorkerMessage } from '@/worker/streams/vfo-workers';
import { isReceiverCommand } from '@/remote/validation';
import { planSharedBands } from '@/worker/streams/channel-plan';

afterEach(() => vi.unstubAllGlobals());
const params = { freq: 144.39, mode: 'nfm', bandwidth: 12500, enabled: false, aprs: true };
const packet = {
	id: 1,
	receivedAt: 1000,
	source: 'N0CALL-9',
	destination: 'APRS',
	path: ['WIDE1-1*'],
	info: '!4903.50N/07201.75W>',
	kind: 'position',
	format: 'uncompressed',
	latitude: 49.05,
	longitude: -72.03,
	symbol: '/>',
};
const station = { id: 'N0CALL-9', type: 'station', lastSeen: 1000, packets: 1, latitude: 49.05, longitude: -72.03, trail: [] };
const message = {
	type: 'aprs',
	freq: params.freq,
	status: { state: 'receiving', message: 'Listening', samples: 1000, frames: 1 },
	stations: [station],
	packets: [packet],
};

describe('APRS local and remote routing', () => {
	it('routes local telemetry by current worker index and drops retuned or removed workers', () => {
		const worker = {};
		const callback = vi.fn();
		const backend = { dspWorkers: [worker], vfoParams: [params] };
		const send = () =>
			routeLocalWorkerMessage(backend, worker, message, null, null, null, null, null, null, null, null, null, null, callback);
		send();
		expect(callback).toHaveBeenCalledWith(0, params.freq, message);
		backend.vfoParams[0] = { ...params, freq: 144.8 };
		send();
		backend.dspWorkers = [];
		send();
		expect(callback).toHaveBeenCalledOnce();
	});
	it('forwards muted remote reception only from the current client worker', async () => {
		vi.stubGlobal(
			'Worker',
			class {
				postMessage = vi.fn();
				terminate = vi.fn();
			},
		);
		const backend = { _sampleRate: 2000000, _centerFreq: 144.4, sharedIqPools: [new ArrayBuffer(32)] };
		for (const [name, method] of Object.entries(remoteBackend)) backend[name] = method.bind(backend);
		const received = vi.fn();
		backend.setRemoteHostAprsCallback(received);
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, params);
		const worker = backend._remoteClients.get('alice').workers[0];
		worker.onmessage({ data: message });
		expect(received).toHaveBeenCalledWith('alice', 0, params.freq, message);
		await backend.setRemoteVfoParams('alice', 0, { ...params, aprs: false });
		worker.onmessage({ data: message });
		backend._reinitRemoteClientWorkers();
		worker.onmessage({ data: message });
		expect(received).toHaveBeenCalledOnce();
	});
	it('validates peer payloads and rejects invalid coordinates, callsigns and oversized logs', () => {
		const command = { type: 'aprs', vfoIndex: 0, freq: params.freq, msg: message };
		expect(isReceiverCommand(command)).toBe(true);
		for (const patch of [{ latitude: 91 }, { id: '<script>' }, { trail: Array(101).fill({ latitude: 0, longitude: 0, time: 0 }) }])
			expect(isReceiverCommand({ ...command, msg: { ...message, stations: [{ ...station, ...patch }] } })).toBe(false);
		for (const patch of [{ source: 'n0call' }, { kind: 'script' }, { info: 'x'.repeat(2001) }, { message: { kind: 'message' } }])
			expect(isReceiverCommand({ ...command, msg: { ...message, packets: [{ ...packet, ...patch }] } })).toBe(false);
		expect(isReceiverCommand({ ...command, msg: { ...message, packets: Array(201).fill(packet) } })).toBe(false);
		const object = { ...station, id: 'AID #2', type: 'item', owner: 'N0CALL' };
		expect(isReceiverCommand({ ...command, msg: { ...message, stations: [object] } })).toBe(true);
	});
	it('keeps muted APRS channels in the shared channel plan', () => {
		const plan = planSharedBands(10000000, 144.6, [params, { ...params, freq: 144.8 }, { ...params, freq: 145.175 }], true);
		expect(plan.bands.flatMap((band) => band.vfos)).toEqual([0, 1, 2]);
	});
});
