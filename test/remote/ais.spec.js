import { afterEach, describe, expect, it, vi } from 'vitest';
import * as remoteBackend from '@/worker/streams/remote-clients';
import { routeLocalWorkerMessage } from '@/worker/streams/vfo-workers';
import { isReceiverCommand } from '@/remote/validation';
import { planSharedBands } from '@/worker/streams/channel-plan';

afterEach(() => vi.unstubAllGlobals());
const params = { freq: 161.975, mode: 'nfm', bandwidth: 12500, enabled: false, ais: true };
const message = {
	type: 'ais',
	freq: params.freq,
	status: { state: 'receiving', message: 'Listening', samples: 1000, frames: 1 },
	vessels: [{ mmsi: '512123456', lastSeen: 1000, messages: 1, latitude: -36, longitude: 174 }],
};
function backend() {
	vi.stubGlobal(
		'Worker',
		class {
			postMessage = vi.fn();
			terminate = vi.fn();
		},
	);
	const value = { _sampleRate: 2000000, _centerFreq: 162, sharedIqPools: [new ArrayBuffer(32)] };
	for (const [name, method] of Object.entries(remoteBackend)) value[name] = method.bind(value);
	return value;
}

describe('AIS local and remote routing', () => {
	it('routes local telemetry using current worker indices and drops retuned or removed workers', () => {
		const removed = {};
		const worker = {};
		const received = vi.fn();
		const value = { dspWorkers: [removed, worker], vfoParams: [params, params] };
		const send = (target) => routeLocalWorkerMessage(value, target, message, null, null, null, null, received);
		send(worker);
		expect(received).toHaveBeenLastCalledWith(1, params.freq, message);
		value.dspWorkers.splice(0, 1);
		value.vfoParams.splice(0, 1);
		send(worker);
		expect(received).toHaveBeenLastCalledWith(0, params.freq, message);
		send(removed);
		value.vfoParams[0] = { ...params, freq: 162.025 };
		send(worker);
		expect(received).toHaveBeenCalledTimes(2);
	});
	it('delivers muted remote AIS only to its client and ignores stale workers after removal and restart', async () => {
		const value = backend();
		const received = vi.fn();
		value.setRemoteHostAisCallback(received);
		for (const id of ['alice', 'bob']) {
			await value.addRemoteClient(id);
			await value.setRemoteVfoParams(id, 0, params);
		}
		await value.addRemoteVfo('alice');
		await value.setRemoteVfoParams('alice', 1, params);
		const state = value._remoteClients.get('alice');
		const removed = state.workers[0];
		const worker = state.workers[1];
		await value.removeRemoteVfo('alice', 0);
		worker.onmessage({ data: message });
		expect(received).toHaveBeenLastCalledWith('alice', 0, params.freq, message);
		removed.onmessage({ data: message });
		await value.setRemoteVfoParams('alice', 0, { ...params, ais: false });
		worker.onmessage({ data: message });
		value._reinitRemoteClientWorkers();
		worker.onmessage({ data: message });
		await value.removeRemoteClient('alice');
		worker.onmessage({ data: message });
		expect(received).toHaveBeenCalledOnce();
	});
	it('validates AIS peer payloads and rejects invalid coordinates, identifiers and oversized arrays', () => {
		const command = { type: 'ais', vfoIndex: 0, freq: params.freq, msg: message };
		expect(isReceiverCommand(command)).toBe(true);
		for (const patch of [{ latitude: 91 }, { mmsi: '123' }, { name: {} }])
			expect(isReceiverCommand({ ...command, msg: { ...message, vessels: [{ ...message.vessels[0], ...patch }] } })).toBe(false);
		expect(isReceiverCommand({ ...command, msg: { ...message, vessels: Array(501).fill(message.vessels[0]) } })).toBe(false);
	});
	it('keeps muted AIS channels in the shared channel plan', () => {
		const plan = planSharedBands(10000000, 162, [params, { ...params, freq: 162.025 }, { ...params, freq: 161.975 }], true);
		expect(plan.bands.flatMap((band) => band.vfos)).toEqual([0, 1, 2]);
	});
});
