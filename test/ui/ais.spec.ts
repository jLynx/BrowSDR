import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type ComponentPublicInstance } from 'vue';
import { ReceiverView } from './helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import { maritimeMid } from '@/app/decoders/ais/database';
import { visibleVessels } from '@/app/decoders/ais/vessels';
import type { AisMessage } from '@/worker/decoders/ais/types';

vi.mock('leaflet', () => ({}));
vi.mock('@/app/decoders/ais/map', () => ({
	VesselMap: vi.fn().mockImplementation(() => ({ update: vi.fn(), destroy: vi.fn(), fit: vi.fn(), resize: vi.fn(), focus: vi.fn() })),
}));
vi.mock('@/app/decoders/ais/database', async (original) => ({
	...(await original()),
	loadMids: vi.fn().mockResolvedValue({ '512': 'New Zealand' }),
}));
let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
});

const message = (): AisMessage => ({
	type: 'ais',
	freq: 161.975,
	status: { state: 'receiving', message: 'Listening', samples: 1000, frames: 2 },
	vessels: [
		{
			mmsi: '512123456',
			name: 'TEST VESSEL',
			lastSeen: Date.now(),
			messages: 2,
			latitude: -36.84,
			longitude: 174.76,
			positionTime: Date.now(),
			speed: 12.3,
		},
	],
});

describe('AIS receiver tools', () => {
	it('keeps AIS telemetry updates out of receiver and VFO control renders', async () => {
		let receiverUpdates = 0;
		let vfoUpdates = 0;
		wrapper = mount(ReceiverView, {
			global: {
				mixins: [
					{
						updated(this: ComponentPublicInstance) {
							if (this === wrapper.vm) receiverUpdates++;
							if (this.$options.name === 'VfoPanel') vfoUpdates++;
						},
					},
				],
			},
		});
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(161.975), ais: true }, makeDefaultVfo(162.025)],
			ais: { panelOpen: true, sources: [], status: [] },
		});
		await nextTick();
		receiverUpdates = vfoUpdates = 0;
		for (let index = 0; index < 10; index++) {
			wrapper.vm._onAisMessage(0, 161.975, message());
			await nextTick();
		}
		expect(wrapper.get('.ais-panel tbody').text()).toContain('TEST VESSEL');
		expect(receiverUpdates).toBe(0);
		expect(vfoUpdates).toBe(0);
	});
	it('controls the selected VFO independently of audio and preserves decoding on close', async () => {
		wrapper = mount(ReceiverView);
		const setVfoParams = vi.fn();
		await wrapper.setData({
			running: true,
			backend: { setVfoParams },
			vfos: [makeDefaultVfo(161.975), makeDefaultVfo(100)],
			ais: { panelOpen: true, sources: [], status: [] },
		});
		await wrapper.get('input[aria-label="AIS decoding for VFO 1"]').setValue(true);
		expect(wrapper.vm.vfos[0]).toMatchObject({ ais: true, enabled: false });
		expect(setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ ais: true, enabled: false }));
		await wrapper.get('select[aria-label="AIS VFO"]').setValue('1');
		expect(wrapper.get('input[aria-label="AIS decoding for VFO 2"]').attributes('disabled')).toBeDefined();
		await wrapper.get('button[aria-label="Close AIS panel"]').trigger('click');
		expect(wrapper.vm.vfos[0].ais).toBe(true);
	});
	it('renders country and vessel details in stable MMSI order, rejecting stale tuning messages', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(161.975), ais: true }],
			ais: { panelOpen: true, sources: [], status: [] },
		});
		const first = message().vessels[0];
		const second = { ...first, mmsi: '512223456', name: 'SECOND' };
		wrapper.vm._onAisMessage(0, 161.975, { ...message(), vessels: [second, first] });
		await nextTick();
		const rows = wrapper.findAll('.ais-panel tbody tr').map((row) => row.element);
		expect(wrapper.findAll('.ais-panel tbody button').map((button) => button.text())).toEqual(['TEST VESSEL', 'SECOND']);
		expect(wrapper.get('.ais-panel tbody').text()).toContain('New Zealand');
		wrapper.vm._onAisMessage(0, 161.975, { ...message(), vessels: [first, second] });
		await nextTick();
		expect(wrapper.findAll('.ais-panel tbody tr').map((row) => row.element)).toEqual(rows);
		wrapper.vm._onAisMessage(0, 162.025, { ...message(), vessels: [] });
		await nextTick();
		expect(wrapper.findAll('.ais-panel tbody tr')).toHaveLength(2);
		await wrapper.find('.ais-panel tbody button').trigger('click');
		expect(wrapper.get('[aria-label="Vessel details"]').text()).toContain('512123456');
	});
	it('extracts MID from maritime identities without assigning countries to rescue beacons', () => {
		for (const mmsi of ['512123456', '051212345', '005121234', '111512123', '851212345', '985121234', '995121234'])
			expect(maritimeMid(mmsi)).toBe('512');
		expect(maritimeMid('970123456')).toBeUndefined();
	});
	it('merges static identity across channels and expires old reports', () => {
		const vessel = message().vessels[0];
		const dynamic = { ...vessel, name: undefined, lastSeen: vessel.lastSeen + 1000 };
		expect(visibleVessels([[vessel], [dynamic]], dynamic.lastSeen)[0].name).toBe('TEST VESSEL');
		const unavailable = { ...dynamic, latitude: undefined, longitude: undefined, speed: undefined, positionTime: dynamic.lastSeen };
		expect(visibleVessels([[vessel], [unavailable]], dynamic.lastSeen)[0]).toMatchObject({
			latitude: undefined,
			longitude: undefined,
			speed: undefined,
		});
		expect(visibleVessels([[vessel]], vessel.lastSeen + 600001)).toEqual([]);
	});
});
