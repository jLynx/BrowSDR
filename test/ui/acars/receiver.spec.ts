import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type ComponentPublicInstance } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AcarsMessage } from '@/worker/decoders/acars/types';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
});
const message = (): AcarsMessage => ({
	type: 'acars',
	freq: 131.55,
	status: { state: 'receiving', message: 'Listening', samples: 1000, frames: 1 },
	messages: [
		{
			id: 1,
			receivedAt: Date.now(),
			registration: 'ZK-NZE',
			mode: '2',
			acknowledgement: 'NAK',
			label: 'H1',
			blockId: '1',
			direction: 'downlink',
			flight: 'ANZ001',
			messageNumber: 'M01A',
			text: 'ARRIVAL GATE 12\r\n<script>test</script>',
			continuation: false,
		},
	],
});

describe('ACARS receiver tools', () => {
	it('controls the selected VFO with muted audio and preserves decoding when closed', async () => {
		wrapper = mount(ReceiverView);
		const setVfoParams = vi.fn();
		await wrapper.setData({
			running: true,
			backend: { setVfoParams },
			vfos: [makeDefaultVfo(131.55), makeDefaultVfo(100)],
			acars: { panelOpen: true, sources: [], status: [] },
		});
		await wrapper.get('input[aria-label="ACARS decoding for VFO 1"]').setValue(true);
		expect(wrapper.vm.vfos[0]).toMatchObject({ acars: true, enabled: false });
		expect(setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ acars: true, enabled: false }));
		await wrapper.get('select[aria-label="ACARS VFO"]').setValue('1');
		expect(wrapper.get('input[aria-label="ACARS decoding for VFO 2"]').attributes('disabled')).toBeDefined();
		await wrapper.get('button[aria-label="Close ACARS panel"]').trigger('click');
		expect(wrapper.vm.vfos[0].acars).toBe(true);
	});
	it('uses normal tuning for the selected VFO without changing audio mode', async () => {
		wrapper = mount(ReceiverView);
		const tune = vi.spyOn(wrapper.vm, 'validateAndApplyVfoFreq').mockImplementation(() => {});
		await wrapper.setData({
			vfos: [makeDefaultVfo(100), makeDefaultVfo(131.55)],
			activeVfoIndex: 1,
			acars: { panelOpen: true, sources: [], status: [] },
		});
		await wrapper.get('select[aria-label="ACARS channel"]').setValue('131.725');
		await wrapper
			.findAll('.acars-panel button')
			.find((button) => button.text() === 'Tune ACARS channel')!
			.trigger('click');
		expect(tune).toHaveBeenCalledWith(1, 131.725);
		expect(wrapper.vm.vfos[1].mode).toBe('wfm');
	});
	it('searches and shows message details as text, rejecting stale data and hiding messages after retuning', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			running: true,
			vfos: [{ ...makeDefaultVfo(131.55), acars: true }],
			acars: { panelOpen: true, sources: [], status: [] },
		});
		wrapper.vm._onAcarsMessage(0, 131.55, message());
		await nextTick();
		expect(wrapper.get('.acars-panel tbody').text()).toContain('ANZ001');
		await wrapper.get('input[aria-label="Search ACARS messages"]').setValue('gate');
		expect(wrapper.findAll('.acars-panel tbody tr')).toHaveLength(1);
		await wrapper.get('.acars-panel tbody button').trigger('click');
		expect(wrapper.get('[aria-label="ACARS message details"]').text()).toContain('M01A');
		expect(wrapper.get('.acars-message-text').text()).toContain('<script>test</script>');
		expect(wrapper.find('.acars-panel script').exists()).toBe(false);
		wrapper.vm._onAcarsMessage(0, 131.725, { ...message(), messages: [] });
		await nextTick();
		expect(wrapper.find('.acars-message-text').exists()).toBe(true);
		wrapper.vm.vfos[0].freq = 131.725;
		await nextTick();
		expect(wrapper.find('.acars-message-text').exists()).toBe(false);
		expect(wrapper.find('.acars-panel tbody').exists()).toBe(false);
	});
	it('keeps telemetry out of receiver and VFO control renders', async () => {
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
			vfos: [{ ...makeDefaultVfo(131.55), acars: true }],
			acars: { panelOpen: true, sources: [], status: [] },
		});
		receiverUpdates = vfoUpdates = 0;
		for (let i = 0; i < 10; i++) {
			wrapper.vm._onAcarsMessage(0, 131.55, message());
			await nextTick();
		}
		expect(wrapper.get('.acars-panel tbody').text()).toContain('ZK-NZE');
		expect(receiverUpdates).toBe(0);
		expect(vfoUpdates).toBe(0);
	});
});
