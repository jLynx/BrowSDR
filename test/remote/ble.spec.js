import { afterEach, describe, expect, it, vi } from 'vitest';
import * as remoteBackend from '@/worker/streams/remote-clients';
import { routeLocalWorkerMessage } from '@/worker/streams/vfo-workers';
import { isReceiverCommand } from '@/remote/validation';
import { planSharedBands } from '@/worker/streams/channel-plan';
import { parseAdvertisement } from '@/worker/decoders/ble/packets';
import { advertisement } from '../decoders/ble/fixtures';

afterEach(() => vi.unstubAllGlobals());
const params = { freq: 2402, mode: 'raw', bandwidth: 48000, enabled: false, ble: true };
const message = {
	type: 'ble',
	freq: 2402,
	status: { state: 'receiving', message: 'Listening', samples: 2000, frames: 1 },
	advertisements: [parseAdvertisement(advertisement(), 37, -10)],
};
describe('BLE routing and remote validation', () => {
	it('routes local packets by current worker index and rejects retuned and removed workers', () => {
		const worker = {},
			removed = {},
			callback = vi.fn();
		const backend = { dspWorkers: [removed, worker], vfoParams: [params, params] };
		const send = (target) => routeLocalWorkerMessage(backend, target, message, null, null, null, null, null, callback);
		send(worker);
		expect(callback).toHaveBeenLastCalledWith(1, 2402, message);
		backend.dspWorkers.splice(0, 1);
		backend.vfoParams.splice(0, 1);
		send(worker);
		expect(callback).toHaveBeenLastCalledWith(0, 2402, message);
		send(removed);
		backend.vfoParams[0] = { ...params, freq: 2426 };
		send(worker);
		expect(callback).toHaveBeenCalledTimes(2);
	});
	it('delivers muted BLE packets only to the subscribing remote client', async () => {
		vi.stubGlobal(
			'Worker',
			class {
				postMessage = vi.fn();
				terminate = vi.fn();
			},
		);
		const backend = { _sampleRate: 8000000, _centerFreq: 2402, sharedIqPools: [new ArrayBuffer(32)] };
		for (const [name, method] of Object.entries(remoteBackend)) backend[name] = method.bind(backend);
		const callback = vi.fn();
		backend.setRemoteHostBleCallback(callback);
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, params);
		const worker = backend._remoteClients.get('alice').workers[0];
		worker.onmessage({ data: message });
		expect(callback).toHaveBeenLastCalledWith('alice', 0, 2402, message);
		await backend.setRemoteVfoParams('alice', 0, { ...params, ble: false });
		worker.onmessage({ data: message });
		await backend.removeRemoteClient('alice');
		worker.onmessage({ data: message });
		expect(callback).toHaveBeenCalledOnce();
	});
	it('validates BLE payloads and rejects unsafe or oversized metadata', () => {
		const command = { type: 'ble', vfoIndex: 0, freq: 2402, msg: message };
		expect(isReceiverCommand(command)).toBe(true);
		for (const patch of [
			{ address: 'bad' },
			{ signalDbfs: NaN },
			{ name: {} },
			{ channel: '37' },
			{ manufacturer: '76' },
			{ services: [{}] },
			{ serviceData: Array(16).fill('a') },
		])
			expect(isReceiverCommand({ ...command, msg: { ...message, advertisements: [{ ...message.advertisements[0], ...patch }] } })).toBe(
				false,
			);
		expect(isReceiverCommand({ ...command, msg: { ...message, advertisements: Array(257).fill(message.advertisements[0]) } })).toBe(false);
	});
	it('keeps muted BLE active at a sample rate sufficient for a full channel', () => {
		const plan = planSharedBands(20000000, 2402, Array(3).fill(params), true);
		expect(plan.direct.concat(plan.bands.flatMap((band) => band.vfos)).sort()).toEqual([0, 1, 2]);
		if (plan.bands.length) expect(plan.sampleRate).toBeGreaterThanOrEqual(2000000);
	});
});
