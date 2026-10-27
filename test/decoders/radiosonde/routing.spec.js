import { afterEach, describe, expect, it, vi } from 'vitest';
import * as remoteBackend from '@/worker/streams/remote-clients';
import { routeLocalWorkerMessage } from '@/worker/streams/vfo-workers';
import { isReceiverCommand } from '@/remote/validation';
import { planSharedBands } from '@/worker/streams/channel-plan';

afterEach(() => vi.unstubAllGlobals());
const params = { freq: 403, mode: 'nfm', bandwidth: 12500, enabled: false, radiosonde: true };
const message = {
	type: 'radiosonde',
	freq: 403,
	status: { state: 'receiving', message: 'Listening', samples: 1000, frames: 1, syncs: 10, crcErrors: 0 },
	sondes: [
		{ id: 'V1234567', model: 'RS41', frame: 42, frequency: 403, lastSeen: 1000, messages: 1, latitude: -36, longitude: 174, trail: [] },
	],
};
describe('Radiosonde routing', () => {
	it('routes local telemetry and rejects old frequencies and removed workers', () => {
		const worker = {};
		const callback = vi.fn();
		const backend = { dspWorkers: [worker], vfoParams: [params] };
		const send = () => routeLocalWorkerMessage(backend, worker, message, null, null, null, null, null, null, null, null, callback);
		send();
		expect(callback).toHaveBeenCalledWith(0, 403, message);
		backend.vfoParams[0] = { ...params, freq: 404 };
		send();
		backend.dspWorkers = [];
		send();
		expect(callback).toHaveBeenCalledOnce();
	});
	it('forwards remote muted reception only from the current client worker', async () => {
		vi.stubGlobal(
			'Worker',
			class {
				postMessage = vi.fn();
				terminate = vi.fn();
			},
		);
		const backend = { _sampleRate: 5000000, _centerFreq: 403, sharedIqPools: [new ArrayBuffer(32)] };
		for (const [name, method] of Object.entries(remoteBackend)) backend[name] = method.bind(backend);
		const received = vi.fn();
		backend.setRemoteHostRadiosondeCallback(received);
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, params);
		const worker = backend._remoteClients.get('alice').workers[0];
		worker.onmessage({ data: message });
		expect(received).toHaveBeenCalledWith('alice', 0, 403, message);
		await backend.setRemoteVfoParams('alice', 0, { ...params, radiosonde: false });
		worker.onmessage({ data: message });
		backend._reinitRemoteClientWorkers();
		worker.onmessage({ data: message });
		expect(received).toHaveBeenCalledOnce();
	});
	it('validates peer payload bounds and retains muted channels in shared plans', () => {
		const command = { type: 'radiosonde', vfoIndex: 0, freq: 403, msg: message };
		expect(isReceiverCommand(command)).toBe(true);
		for (const patch of [
			{ latitude: 91 },
			{ id: '<script>' },
			{ trail: Array(301).fill({ latitude: 0, longitude: 0, altitude: 0, time: 0 }) },
		])
			expect(isReceiverCommand({ ...command, msg: { ...message, sondes: [{ ...message.sondes[0], ...patch }] } })).toBe(false);
		const plan = planSharedBands(10000000, 403, [params, { ...params, freq: 403.1 }, { ...params, freq: 403.2 }], true);
		expect(plan.bands.flatMap((band) => band.vfos)).toEqual([0, 1, 2]);
	});
});
