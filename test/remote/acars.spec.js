import { afterEach, describe, expect, it, vi } from 'vitest';
import * as remoteBackend from '@/worker/streams/remote-clients';
import { routeLocalWorkerMessage } from '@/worker/streams/vfo-workers';
import { isReceiverCommand } from '@/remote/validation';
import { planSharedBands } from '@/worker/streams/channel-plan';

afterEach(() => vi.unstubAllGlobals());
const params = { freq: 131.55, mode: 'nfm', bandwidth: 12500, enabled: false, acars: true };
const message = {
	type: 'acars',
	freq: params.freq,
	status: { state: 'receiving', message: 'Listening', samples: 1000, frames: 1 },
	messages: [
		{
			id: 1,
			receivedAt: 1000,
			registration: 'ZK-NZE',
			mode: '2',
			acknowledgement: 'NAK',
			label: 'H1',
			blockId: '1',
			direction: 'downlink',
			text: 'TEST',
			continuation: false,
		},
	],
};
function backend() {
	vi.stubGlobal(
		'Worker',
		class {
			postMessage = vi.fn();
			terminate = vi.fn();
		},
	);
	const value = { _sampleRate: 2000000, _centerFreq: 131.6, sharedIqPools: [new ArrayBuffer(32)] };
	for (const [name, method] of Object.entries(remoteBackend)) value[name] = method.bind(value);
	return value;
}

describe('ACARS local and remote routing', () => {
	it('routes local telemetry using current worker indices and drops retuned or removed workers', () => {
		const removed = {};
		const worker = {};
		const received = vi.fn();
		const value = { dspWorkers: [removed, worker], vfoParams: [params, params] };
		const send = (target) => routeLocalWorkerMessage(value, target, message, null, null, null, null, null, null, received);
		send(worker);
		expect(received).toHaveBeenLastCalledWith(1, params.freq, message);
		value.dspWorkers.splice(0, 1);
		value.vfoParams.splice(0, 1);
		send(worker);
		expect(received).toHaveBeenLastCalledWith(0, params.freq, message);
		send(removed);
		value.vfoParams[0] = { ...params, freq: 131.725 };
		send(worker);
		expect(received).toHaveBeenCalledTimes(2);
	});
	it('delivers muted remote ACARS only to its client and ignores stale workers after removal and restart', async () => {
		const value = backend();
		const received = vi.fn();
		value.setRemoteHostAcarsCallback(received);
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
		await value.setRemoteVfoParams('alice', 0, { ...params, acars: false });
		worker.onmessage({ data: message });
		value._reinitRemoteClientWorkers();
		worker.onmessage({ data: message });
		await value.removeRemoteClient('alice');
		worker.onmessage({ data: message });
		expect(received).toHaveBeenCalledOnce();
	});
	it('validates ACARS peer payloads and rejects invalid fields and oversized arrays', () => {
		const command = { type: 'acars', vfoIndex: 0, freq: params.freq, msg: message };
		expect(isReceiverCommand(command)).toBe(true);
		for (const patch of [{ id: -1 }, { receivedAt: NaN }, { registration: {} }, { text: {} }, { text: 'x'.repeat(241) }])
			expect(isReceiverCommand({ ...command, msg: { ...message, messages: [{ ...message.messages[0], ...patch }] } })).toBe(false);
		expect(isReceiverCommand({ ...command, msg: { ...message, messages: Array(201).fill(message.messages[0]) } })).toBe(false);
	});
	it('keeps muted ACARS channels in the shared channel plan', () => {
		const plan = planSharedBands(10000000, 131.6, [params, { ...params, freq: 131.725 }, { ...params, freq: 131.55 }], true);
		expect(plan.bands.flatMap((band) => band.vfos)).toEqual([0, 1, 2]);
	});
});
