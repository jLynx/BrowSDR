import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import { makeDefaultVfo } from '@/app/core/constants';
import { createAppData } from '@/app/core/state';
import type { AppInstance } from '@/app/core/receiver.types';
import { vfoMethods } from '@/app/radio/vfo';
import { rtkMethods } from '@/app/decoders/rtk/controller';
import RtkPanel from '@/app/decoders/rtk/panel';
import { mockStation, mockStationMessage } from './fixtures';

let wrapper: VueWrapper;
afterEach(() => wrapper?.unmount());

function setup() {
	const backend = { setVfoParams: vi.fn(), addVfo: vi.fn(), removeVfo: vi.fn() };
	const receiver = reactive({
		...createAppData(),
		...vfoMethods,
		...rtkMethods,
		running: true,
		backend,
		radio: { centerFreq: 921.5, sampleRate: 20000000 },
		vfos: [{ ...makeDefaultVfo(923.118), rtk: true, rtkProfile: 'scan' as const }],
		showMsg: vi.fn(),
	}) as unknown as AppInstance;
	receiver.rtk.panelOpen = true;
	wrapper = mount(RtkPanel, { global: { provide: { receiver } } });
	const bases = [100, 101, 102].map((scan) => ({
		...mockStation(scan),
		reference: undefined,
		discovery: { profile: 'rtk1' as const, frequencyMHz: 923.118, frequenciesMHz: [923.118], hoppingObserved: false, verifiedFrames: 2 },
	}));
	const report = (stations = bases) => {
		const message = mockStationMessage(923.118, stations);
		message.status.scan = { startMHz: 915, endMHz: 928, frequencyMHz: 923.118, channel: 1, channels: 30, pass: 1, remainingSeconds: 60 };
		receiver._onRtkMessage(0, 923.118, message);
	};
	const decode = () => wrapper.get('input[aria-label="RTK decoding for VFO 1"]');
	return { receiver, backend, bases, report, decode };
}

describe('RTK discovery decode lifecycle', () => {
	it('recreates deleted tracking VFOs after toggling Decode and deduplicates repeated reports', async () => {
		const { receiver, backend, report, decode } = setup();
		report();
		await flushPromises();
		expect(receiver.vfos).toHaveLength(4);
		for (let index = 3; index > 0; index--) await receiver.removeVfo(index);
		report();
		await flushPromises();
		expect(receiver.vfos).toHaveLength(1);
		await decode().setValue(false);
		report();
		await flushPromises();
		expect(receiver.vfos).toHaveLength(1);
		await decode().setValue(true);
		for (let i = 0; i < 4; i++) report();
		await flushPromises();
		expect(receiver.vfos).toHaveLength(4);
		expect(backend.addVfo).toHaveBeenCalledTimes(6);
		expect(new Set(receiver.vfos.slice(1).map((vfo) => vfo.rtkFollowSource)).size).toBe(3);
		expect(receiver.vfos.slice(1).every((vfo) => vfo.rtk && vfo.rtkProfile === 'auto' && !vfo.enabled)).toBe(true);
		expect(receiver.vfos[0].rtkProfile).toBe('scan');
		expect(receiver.activeVfoIndex).toBe(0);
		expect(receiver.radio).toEqual({ centerFreq: 921.5, sampleRate: 20000000 });
	});
	it('reuses remaining enabled and disabled trackers when restarting the scout', async () => {
		const { receiver, backend, report, decode } = setup();
		report();
		await flushPromises();
		const disabled = receiver.vfos[1],
			enabled = receiver.vfos[2];
		disabled.rtk = false;
		receiver.updateBackendVfoParams(1);
		await receiver.removeVfo(3);
		await decode().setValue(false);
		await decode().setValue(true);
		report();
		await flushPromises();
		expect(receiver.vfos).toHaveLength(4);
		expect(receiver.vfos[1]).toBe(disabled);
		expect(receiver.vfos[1].rtk).toBe(false);
		expect(receiver.vfos[2]).toBe(enabled);
		expect(receiver.vfos[2].rtk).toBe(true);
		expect(backend.addVfo).toHaveBeenCalledTimes(4);
	});
	it('invalidates queued discoveries even when Decode is immediately re-enabled', async () => {
		const { receiver, backend, bases, report } = setup();
		report([bases[0]]);
		receiver.vfos[0].rtk = false;
		receiver.updateBackendVfoParams(0);
		receiver.vfos[0].rtk = true;
		receiver.updateBackendVfoParams(0);
		report([bases[1]]);
		await flushPromises();
		expect(backend.addVfo).toHaveBeenCalledTimes(1);
		expect(receiver.vfos[1].rtkFollowSource).toBe('101.7.42');
	});
	it('recreates removed trackers after leaving and returning to the discovery profile', async () => {
		const { receiver, report } = setup();
		report();
		await flushPromises();
		for (let index = 3; index > 0; index--) await receiver.removeVfo(index);
		const profile = wrapper.get('select[aria-label="RTK signal profile"]');
		await profile.setValue('rtk1');
		await profile.setValue('scan');
		report();
		await flushPromises();
		expect(receiver.vfos).toHaveLength(4);
	});
	it('restarts only the selected scout allocation session', async () => {
		const { receiver, backend, bases, report, decode } = setup();
		receiver.vfos.push({ ...makeDefaultVfo(923.118), rtk: true, rtkProfile: 'scan' });
		const other = mockStationMessage(923.118, [bases[1]]);
		other.status.scan = { startMHz: 915, endMHz: 928, frequencyMHz: 923.118, channel: 1, channels: 30, pass: 1, remainingSeconds: 60 };
		report([bases[0]]);
		receiver._onRtkMessage(1, 923.118, other);
		await flushPromises();
		await receiver.removeVfo(3);
		await receiver.removeVfo(2);
		await decode().setValue(false);
		await decode().setValue(true);
		report([bases[0]]);
		receiver._onRtkMessage(1, 923.118, other);
		await flushPromises();
		expect(receiver.vfos).toHaveLength(3);
		expect(receiver.vfos[2].rtkFollowSource).toBe('100.7.42');
		expect(backend.addVfo).toHaveBeenCalledTimes(3);
	});
	it('clears the scout allocation session while reception is stopped and the backend is absent', async () => {
		const { receiver, report, decode } = setup();
		report();
		await flushPromises();
		for (let index = 3; index > 0; index--) await receiver.removeVfo(index);
		receiver.running = false;
		receiver.backend = null;
		await decode().setValue(false);
		await decode().setValue(true);
		receiver.running = true;
		report();
		await flushPromises();
		expect(receiver.vfos).toHaveLength(4);
	});
});
