import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type ComponentPublicInstance } from 'vue';
import { makeDefaultVfo } from '@/app/core/constants';
import VfoPanel from '@/app/radio/vfo-panel';
import * as components from '@/ui';
import { ReceiverView } from './helpers/receiver-view';

let wrapper: VueWrapper;

afterEach(() => {
	wrapper?.unmount();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('receiver uses the shared UI', () => {
	it('preserves paired USB device identity through the reactive picker', async () => {
		const device = { vendorId: 0x04b4, productId: 0x00f1, productName: 'LimeSDR', serialNumber: 'test' } as USBDevice;
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn().mockResolvedValue([device]), requestDevice: vi.fn() } });
		wrapper = mount(ReceiverView);
		await wrapper.setData({ backend: {} });
		vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
		await wrapper.vm.connect();
		expect(wrapper.vm.devicePicker.devices[0].device).toBe(device);
		const connectDevice = vi.fn();
		await wrapper.setData({ workspace: { connectDevice } });
		await wrapper.get('.device-picker-item').trigger('click');
		expect(connectDevice).toHaveBeenCalledWith(wrapper.vm, device);
	});
	it('updates only the affected VFO panel for decoder telemetry and no panels for receiver stats', async () => {
		const updates: number[] = [];
		wrapper = mount(ReceiverView, {
			global: {
				mixins: [
					{
						updated(this: ComponentPublicInstance) {
							if (this.$options.name === 'VfoPanel') updates.push((this.$props as { i: number }).i);
						},
					},
				],
			},
		});
		await wrapper.setData({ vfos: Array.from({ length: 27 }, (_, i) => ({ ...makeDefaultVfo(414 + i), mode: 'dsd', enabled: true })) });
		const panels = wrapper.findAllComponents(VfoPanel);
		updates.length = 0;
		wrapper.vm.dsdStatus[7] = { synced: true, mode: 'dmr', syncCount: 42, voiceFrameCount: 12, mbelibLoaded: true };
		await nextTick();
		expect(panels[7].text()).toContain('DMR · 42 bursts');
		expect(updates).toEqual([7]);
		updates.length = 0;
		await wrapper.setData({ showStats: true, dspStats: { inputRate: 61440000 }, fps: 60 });
		expect(updates).toEqual([]);
	});
	it('keeps VFO controls and telemetry attached to their current index after removal', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			connected: true,
			running: true,
			vfos: [
				{ ...makeDefaultVfo(414), mode: 'dsd', enabled: true },
				{ ...makeDefaultVfo(455), mode: 'dsd', enabled: true },
			],
		});
		let panels = wrapper.findAllComponents(VfoPanel);
		await panels[1].get('input[aria-label="Bandwidth"]').setValue('15000');
		expect(wrapper.vm.vfos[1].bandwidth).toBe(15000);
		expect(wrapper.vm.vfos[0].bandwidth).toBe(150000);
		wrapper.vm.vfos.splice(0, 1);
		wrapper.vm.dsdStatus = [{ synced: true, mode: 'dmr', syncCount: 9 }];
		await nextTick();
		panels = wrapper.findAllComponents(VfoPanel);
		expect(panels).toHaveLength(1);
		expect(panels[0].text()).toContain('DMR · 9 bursts');
		expect(panels[0].get('input[aria-label="Bandwidth"]').element).toHaveProperty('value', '15000');
	});
	it('shows USB guidance only when Add SDR is opened, with pairing disabled and Mock SDR available', async () => {
		vi.stubGlobal('isSecureContext', true);
		wrapper = mount(ReceiverView, { attachTo: document.body });
		expect(wrapper.find('.ui-notice').exists()).toBe(false);
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Add SDR')!
			.trigger('click');
		expect(wrapper.get('.ui-notice').text()).toContain('WebUSB is unavailable');
		expect(wrapper.get('.ui-notice a').attributes('href')).toBe('https://caniuse.com/webusb');
		expect(
			wrapper
				.findAll('button')
				.find((button) => button.text() === 'Pair New Device')!
				.attributes('disabled'),
		).toBeDefined();
		const demo = vi.fn();
		await wrapper.setData({ workspace: { connectDevice: demo } });
		await wrapper
			.findAll('button')
			.find((button) => button.text().includes('Mock SDR'))!
			.trigger('click');
		expect(demo).toHaveBeenCalledOnce();
		expect(wrapper.vm.devicePicker.show).toBe(false);
	});
	it('does not open the USB picker for remote clients', async () => {
		wrapper = mount(ReceiverView, { attachTo: document.body });
		await wrapper.setData({ remoteMode: 'client' });
		await wrapper.vm.connect();
		expect(wrapper.find('.ui-notice').exists()).toBe(false);
		expect(wrapper.vm.devicePicker.show).toBe(false);
	});
	it('keeps USB permission errors separate from compatibility guidance', async () => {
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn().mockRejectedValue(new Error('Permission denied')), requestDevice: vi.fn() } });
		wrapper = mount(ReceiverView, { attachTo: document.body });
		await wrapper.setData({ backend: {} });
		vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
		const message = vi.spyOn(wrapper.vm, 'showMsg').mockImplementation(() => {});
		await wrapper.vm.connect();
		expect(wrapper.vm.usbCapabilityIssue).toBeNull();
		expect(message).toHaveBeenCalledWith('USB access failed: Permission denied');
	});
	it('opens the remote dialog and keeps its native input model connected', async () => {
		wrapper = mount(ReceiverView, { attachTo: document.body });
		const connect = wrapper.findAll('button').find((button) => button.text() === 'Connect Remote')!;
		await connect.trigger('click');
		const input = wrapper.find('[role=dialog] input');
		await input.setValue('sample-share-code');
		expect(wrapper.vm.remoteConnectId).toBe('sample-share-code');
		await input.trigger('keyup', { key: 'Escape' });
		expect(wrapper.find('[role=dialog]').exists()).toBe(false);
	});
	it('updates radio numbers and preserves collapse state through the panel component', async () => {
		wrapper = mount(ReceiverView, { attachTo: document.body });
		await wrapper.setData({ connected: true });
		const panels = wrapper.findAllComponents(components.UiPanel);
		const radio = panels.find((panel) => panel.props('label') === 'Radio')!;
		await radio.find('input').setValue('106.5');
		expect(wrapper.vm.radio.centerFreq).toBe(106.5);
		await radio.find('[role=button]').trigger('click');
		expect(wrapper.vm.collapsedPanels.radio).toBe(true);
		expect(radio.find('.panel-body').isVisible()).toBe(false);
		await radio.find('[role=button]').trigger('keydown', { key: 'Enter' });
		expect(wrapper.vm.collapsedPanels.radio).toBe(false);
	});
	it('retains the receiver bookmark input ref inside the shared dialog', async () => {
		wrapper = mount(ReceiverView, { attachTo: document.body });
		await wrapper.setData({ bookmarkModal: { show: true, type: 'individual', name: 'Station', category: '' } });
		const input = wrapper.find('[role=dialog] input');
		expect(wrapper.vm.$refs.bookmarkNameInput).toBe(input.element);
		await input.setValue('New station');
		expect(wrapper.vm.bookmarkModal.name).toBe('New station');
		await wrapper.find('.bookmark-overlay').trigger('click');
		expect(wrapper.vm.bookmarkModal.show).toBe(false);
	});
	it('updates numeric gain switches and keeps client locks read-only', async () => {
		wrapper = mount(ReceiverView, { attachTo: document.body });
		await wrapper.setData({
			connected: true,
			remoteMode: 'client',
			deviceCapabilities: { deviceType: 'hackrf', sampleRates: [2000000], gainControls: [{ name: 'Amp', type: 'toggle' }] },
			gains: { Amp: 0 },
			locks: { centerFreq: true, sampleRate: true, Amp: false },
		});
		await wrapper.find('.checkbox input').setValue(true);
		expect(wrapper.vm.gains.Amp).toBe(1);
		await wrapper.find('.lock-btn').trigger('click');
		expect(wrapper.vm.locks.centerFreq).toBe(true);
	});
});
