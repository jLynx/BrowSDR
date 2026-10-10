import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type ComponentPublicInstance } from 'vue';
import { makeDefaultVfo } from '@/app/core/constants';
import { UiMenu } from '@/ui';
import { ReceiverView } from '../helpers/receiver-view';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.restoreAllMocks();
});

describe('decoder tools menu', () => {
	it('opens panels without enabling decoders, and keeps utilities separate', async () => {
		wrapper = mount(ReceiverView, { attachTo: document.body });
		expect(wrapper.findAll('.active-decoder-tool')).toHaveLength(0);
		await wrapper.get('.tools-trigger').trigger('click');
		const groups = wrapper.findAll('.ui-menu-group');
		expect(groups.map((group) => group.get('.ui-menu-group-label').text())).toEqual(['Decoders', 'Utilities']);
		expect(groups[0].findAll('button')).toHaveLength(8);
		expect(wrapper.get('.ui-menu-list').text()).toContain('Sensor & device data · rtl_433');
		await wrapper.get('button[aria-label="Wireless Sensors"]').trigger('click');
		expect(wrapper.vm.rtl433.panelOpen).toBe(true);
		expect(wrapper.vm.vfos[0].rtl433).toBe(false);
		expect(wrapper.findAll('.active-decoder-tool')).toHaveLength(0);
		expect(wrapper.find('.ui-menu-list').exists()).toBe(false);
		expect(document.activeElement).toBe(wrapper.get('.tools-trigger').element);
	});

	it('deduplicates enabled decoders across VFOs and reopens their panels without changing configuration', async () => {
		wrapper = mount(ReceiverView);
		const vfo = { ...makeDefaultVfo(433.92), rtl433: true, adsb: true };
		await wrapper.setData({ vfos: [vfo, { ...vfo, freq: 315 }] });
		expect(wrapper.findAll('.active-decoder-tool').map((button) => button.text())).toEqual(['Wireless Sensors', 'ADS-B']);
		await wrapper.get('button[aria-label="Open Wireless Sensors decoder"]').trigger('click');
		await wrapper.get('button[aria-label="Open Wireless Sensors decoder"]').trigger('click');
		expect(wrapper.vm.rtl433.panelOpen).toBe(true);
		await wrapper.get('button[aria-label="Close Wireless Sensors panel"]').trigger('click');
		expect(wrapper.vm.rtl433.panelOpen).toBe(false);
		expect(wrapper.findAll('.active-decoder-tool')).toHaveLength(2);
		expect(wrapper.vm.vfos.map((item) => item.rtl433)).toEqual([true, true]);
		wrapper.vm.vfos[0].rtl433 = false;
		await nextTick();
		expect(wrapper.find('button[aria-label="Open Wireless Sensors decoder"]').exists()).toBe(true);
		wrapper.vm.vfos[1].rtl433 = false;
		await nextTick();
		expect(wrapper.find('button[aria-label="Open Wireless Sensors decoder"]').exists()).toBe(false);
	});

	it('only marks RDS active on a WFM VFO while preserving its setting across mode changes', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			vfos: [makeDefaultVfo(106.2), { ...makeDefaultVfo(107.1), mode: 'nfm', rds: true }],
		});
		await wrapper.get('.tools-trigger').trigger('click');
		const rdsItem = wrapper.get('button[aria-label="FM RDS"]');
		const shortcut = () => wrapper.find('button[aria-label="Open FM RDS decoder"]');
		expect(shortcut().exists()).toBe(false);
		expect(rdsItem.classes()).not.toContain('active');
		wrapper.vm.vfos[1].mode = 'wfm';
		await nextTick();
		expect(shortcut().exists()).toBe(true);
		expect(rdsItem.classes()).toContain('active');
		wrapper.vm.vfos[0].rds = true;
		wrapper.vm.vfos[1].mode = 'nfm';
		await nextTick();
		expect(wrapper.findAll('button[aria-label="Open FM RDS decoder"]')).toHaveLength(1);
		wrapper.vm.vfos[0].mode = 'am';
		await nextTick();
		expect(shortcut().exists()).toBe(false);
		expect(rdsItem.classes()).not.toContain('active');
		expect(wrapper.vm.vfos.map((vfo) => vfo.rds)).toEqual([true, true]);
	});

	it('does not refresh the toolbar for incoming decoder telemetry', async () => {
		let toolbarUpdates = 0;
		wrapper = mount(ReceiverView, {
			global: {
				mixins: [
					{
						updated(this: ComponentPublicInstance) {
							if (this.$options.name === 'HeaderTools') toolbarUpdates++;
						},
					},
				],
			},
		});
		await wrapper.setData({ vfos: [{ ...makeDefaultVfo(433.92), rtl433: true }] });
		toolbarUpdates = 0;
		wrapper.vm.rtl433.status[0] = { state: 'receiving', message: 'Listening', samples: 100, events: 1 };
		wrapper.vm.rtl433.log.push({ vfoIndex: 0, freq: 433.92, event: { model: 'Weather sensor' }, timestamp: '12:00' });
		await nextTick();
		expect(toolbarUpdates).toBe(0);
	});
});

describe('shared menu dismissal', () => {
	const groups = [{ label: 'Tools', items: [{ id: 'rds', label: 'RDS', icon: 'radio' as const }] }];
	it('supports Escape, outside clicks and focus leaving the disclosure', async () => {
		wrapper = mount(UiMenu, { attachTo: document.body, props: { id: 'test-tools', groups } });
		const trigger = wrapper.get('.tools-trigger');
		await trigger.trigger('click');
		await wrapper.get('.ui-menu-item').trigger('keydown', { key: 'Escape' });
		expect(wrapper.find('.ui-menu-list').exists()).toBe(false);
		expect(document.activeElement).toBe(trigger.element);
		await trigger.trigger('click');
		document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		await nextTick();
		expect(wrapper.find('.ui-menu-list').exists()).toBe(false);
		await trigger.trigger('click');
		await wrapper.get('.ui-menu-item').trigger('focusout', { relatedTarget: document.body });
		expect(wrapper.find('.ui-menu-list').exists()).toBe(false);
	});
});
