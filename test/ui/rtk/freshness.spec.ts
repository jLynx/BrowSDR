import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import { mockStation, mockStationMessage } from './fixtures';

let wrapper: VueWrapper<InstanceType<typeof ReceiverView>>;
afterEach(() => {
	wrapper?.unmount();
	vi.useRealTimers();
});

async function setup() {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
	wrapper = mount(ReceiverView);
	await wrapper.setData({
		running: true,
		connected: true,
		centerFreq: 923.118,
		vfos: [{ ...makeDefaultVfo(923.118), rtk: true, enabled: false }],
	});
	wrapper.vm.rtk.panelOpen = true;
}

describe('RTK satellite freshness', () => {
	it('keeps the last complete observations visible when fresh position corrections arrive without satellite data', async () => {
		await setup();
		const station = mockStation();
		station.reference = undefined;
		station.observations = {
			GPS: {
				type: 1074,
				stationId: 42,
				constellation: 'GPS',
				epochMs: 1234,
				multipleMessage: false,
				satellites: [1, 3],
				signals: [2, 8],
				cells: 2,
				cnrDbHz: [40, 42],
				receivedAt: Date.now(),
				measurements: [
					{ satellite: 1, signal: 2, cnrDbHz: 40, band: 'L1', group: 'primary' },
					{ satellite: 3, signal: 8, cnrDbHz: 42, band: 'L2', group: 'secondary' },
				],
			},
		};
		const send = () => wrapper.vm._onRtkMessage(0, 923.118, mockStationMessage(923.118, [structuredClone(station)]));
		send();
		await nextTick();
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Live corrections');
		expect(wrapper.get('[aria-label="Satellite observations"] strong').text()).toBe('2');
		await vi.advanceTimersByTimeAsync(6000);
		station.lastCorrection = Date.now();
		send();
		await nextTick();
		expect(wrapper.get('[aria-label="Time since last RTK update"]').text()).toBe('Last correction: 0 s ago');
		expect(wrapper.get('[aria-label="Satellite data freshness"]').text()).toContain('Satellite update: 6 s ago');
		expect(wrapper.get('[aria-label="Satellite data freshness"]').text()).toContain('Showing last received observations');
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Corrections received');
		expect(wrapper.get('[aria-label="Satellite observations"] strong').text()).toBe('2');
		expect(wrapper.get('[aria-label="Satellites by frequency group"]').text()).toContain('L1 / primary1');
		expect(wrapper.get('[aria-label="GNSS signal quality"]').text()).toContain('Good');
		station.observations.GPS.receivedAt = Date.now();
		send();
		await nextTick();
		expect(wrapper.get('[aria-label="Satellite data freshness"]').text()).toContain('Satellite update: 0 s ago · Current observations');
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Live corrections');
	});

	it('explains when verified base corrections have never included a complete satellite sequence', async () => {
		await setup();
		const station = mockStation();
		station.reference = undefined;
		wrapper.vm._onRtkMessage(0, 923.118, mockStationMessage(923.118, [station]));
		await nextTick();
		expect(wrapper.get('.rtk-heading .rtk-state').text()).toBe('Corrections received');
		expect(wrapper.get('[aria-label="Satellite data freshness"]').text()).toContain(
			'Waiting for a complete satellite observation sequence',
		);
		expect(wrapper.get('[aria-label="Satellite observations"] strong').text()).toBe('—');
	});
});
