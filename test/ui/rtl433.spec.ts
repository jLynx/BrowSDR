import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { makeDefaultVfo } from '@/app/core/constants';
import { ReceiverView } from './helpers/receiver-view';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('rtl_433 tool controls', () => {
	it('configures each chosen VFO independently and keeps decoding when the tool closes', async () => {
		wrapper = mount(ReceiverView);
		const setVfoParams = vi.fn();
		await wrapper.setData({ running: true, backend: { setVfoParams }, vfos: [makeDefaultVfo(433.92), makeDefaultVfo(315)] });
		expect(wrapper.find('input[aria-label="Wireless Sensors decoding for VFO 1"]').exists()).toBe(false);
		expect(wrapper.findAll('label').some((label) => label.text().includes('Decode rtl_433 sensors'))).toBe(false);
		wrapper.vm.toggleRtl433Panel();
		await nextTick();
		await wrapper.get('input[aria-label="Wireless Sensors decoding for VFO 1"]').setValue(true);
		await wrapper.get('#test-receiver-rtl433-tool-rate').setValue('1000000');
		await wrapper.get('#test-receiver-rtl433-tool-protocols').setValue('2, 3');
		expect(wrapper.vm.vfos[0]).toMatchObject({ rtl433: true, rtl433SampleRate: 1000000, rtl433Protocols: '2, 3', enabled: false });
		await wrapper.get('select[aria-label="Wireless Sensors VFO"]').setValue('1');
		expect(wrapper.vm.activeVfoIndex).toBe(1);
		expect(wrapper.get('#test-receiver-rtl433-tool-rate').element).toHaveProperty('value', '250000');
		await wrapper.get('input[aria-label="Wireless Sensors decoding for VFO 2"]').setValue(true);
		expect(setVfoParams).toHaveBeenLastCalledWith(
			1,
			expect.objectContaining({ freq: 315, rtl433: true, rtl433SampleRate: 250000, rtl433Protocols: '' }),
		);
		await wrapper.get('button[aria-label="Close Wireless Sensors panel"]').trigger('click');
		expect(wrapper.vm.vfos.map((vfo) => vfo.rtl433)).toEqual([true, true]);
		wrapper.vm.toggleRtl433Panel();
		await nextTick();
		await wrapper.get('select[aria-label="Wireless Sensors VFO"]').setValue('0');
		expect(wrapper.get('#test-receiver-rtl433-tool-protocols').element).toHaveProperty('value', '2, 3');
	});
	it('preserves events, protocol search, export and clear actions', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({ running: true, vfos: [{ ...makeDefaultVfo(433.92), rtl433: true }], rtl433: { panelOpen: true } });
		wrapper.vm._onRtl433Message(0, 433.92, {
			type: 'rtl433_status',
			status: {
				state: 'receiving',
				message: 'Listening',
				samples: 100,
				events: 1,
				protocols: [{ id: 2, name: 'Test weather sensor', disabled: false }],
			},
		});
		wrapper.vm._onRtl433Message(0, 433.92, {
			type: 'rtl433_event',
			freq: 433.92,
			event: { model: 'Test weather sensor', temperature_C: 20 },
		});
		await nextTick();
		expect(wrapper.get('.rtl433-entry').text()).toContain('temperature_C: 20');
		const createObjectURL = vi.fn(() => 'blob:rtl433-test');
		const revokeObjectURL = vi.fn();
		vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
		const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		await wrapper
			.findAll('.rtl433-panel button')
			.find((button) => button.text() === 'Export JSONL')!
			.trigger('click');
		expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
		expect(download).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:rtl433-test');
		await wrapper
			.findAll('.rtl433-panel button')
			.find((button) => button.text() === 'Protocols')!
			.trigger('click');
		expect(wrapper.get('.rtl433-protocols').text()).toContain('[2] Test weather sensor');
		await wrapper.get('input[aria-label="Search wireless sensor protocols"]').setValue('unknown');
		expect(wrapper.get('.rtl433-protocols').text()).not.toContain('Test weather sensor');
		await wrapper
			.findAll('.rtl433-panel button')
			.find((button) => button.text() === 'Clear')!
			.trigger('click');
		expect(wrapper.vm.rtl433.log).toHaveLength(0);
	});
});
