import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent } from 'vue';
import template from '../../src/client/app/receiver.html?raw';
import * as components from '../../src/client/ui';
import { createAppData } from '../../src/client/app/state';
import { computedProperties } from '../../src/client/app/computed';
import { uiHelperMethods } from '../../src/client/app/ui-helpers';
import { autoGainMethods } from '../../src/client/app/auto-gain';
import { rdsMethods } from '../../src/client/app/rds';
import { rtl433Methods } from '../../src/client/app/rtl433';
import { bookmarkMethods } from '../../src/client/app/bookmarks';
import { zoomMethods } from '../../src/client/app/zoom';
import { audioMethods } from '../../src/client/app/audio';
import { whisperMethods } from '../../src/client/app/whisper';
import { pocsagMethods } from '../../src/client/app/pocsag';
import { vfoMethods } from '../../src/client/app/vfo';
import { connectionMethods } from '../../src/client/app/connection';
import { remoteMethods } from '../../src/client/app/remote';

let wrapper: VueWrapper;
const ReceiverView = defineComponent({
	template, components,
	data: () => ({ ...createAppData(), receiverId: 'test-receiver', workspace: null }),
	computed: computedProperties,
	methods: {
		...uiHelperMethods, ...autoGainMethods, ...rdsMethods, ...rtl433Methods, ...bookmarkMethods,
		...zoomMethods, ...audioMethods, ...whisperMethods, ...pocsagMethods, ...vfoMethods, ...connectionMethods, ...remoteMethods,
		isFreqInBandwidth: () => true,
	},
});
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('receiver uses the shared UI', () => {
	it('shows USB guidance only when Add SDR is opened, with pairing disabled and Mock SDR available', async () => {
		vi.stubGlobal('isSecureContext', true);
		wrapper = mount(ReceiverView, { attachTo: document.body });
		expect(wrapper.find('.ui-notice').exists()).toBe(false);
		await wrapper.findAll('button').find(button => button.text() === 'Add SDR')!.trigger('click');
		expect(wrapper.get('.ui-notice').text()).toContain('WebUSB is unavailable');
		expect(wrapper.get('.ui-notice a').attributes('href')).toBe('https://caniuse.com/webusb');
		expect(wrapper.findAll('button').find(button => button.text() === 'Pair New Device')!.attributes('disabled')).toBeDefined();
		const demo = vi.fn();
		await wrapper.setData({ workspace: { connectDevice: demo } });
		await wrapper.findAll('button').find(button => button.text().includes('Mock SDR'))!.trigger('click');
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
		const connect = wrapper.findAll('button').find(button => button.text() === 'Connect Remote')!;
		await connect.trigger('click');
		const input = wrapper.find('[role=dialog] input');
		await input.setValue('sample-share-code'); expect(wrapper.vm.remoteConnectId).toBe('sample-share-code');
		await input.trigger('keyup', { key: 'Escape' }); expect(wrapper.find('[role=dialog]').exists()).toBe(false);
	});
	it('updates radio numbers and preserves collapse state through the panel component', async () => {
		wrapper = mount(ReceiverView, { attachTo: document.body });
		await wrapper.setData({ connected: true });
		const panels = wrapper.findAllComponents(components.UiPanel);
		const radio = panels.find(panel => panel.props('label') === 'Radio')!;
		await radio.find('input').setValue('106.5'); expect(wrapper.vm.radio.centerFreq).toBe(106.5);
		await radio.find('[role=button]').trigger('click'); expect(wrapper.vm.collapsedPanels.radio).toBe(true);
		expect(radio.find('.panel-body').isVisible()).toBe(false);
		await radio.find('[role=button]').trigger('keydown', { key: 'Enter' }); expect(wrapper.vm.collapsedPanels.radio).toBe(false);
	});
	it('retains the receiver bookmark input ref inside the shared dialog', async () => {
		wrapper = mount(ReceiverView, { attachTo: document.body });
		await wrapper.setData({ bookmarkModal: { show: true, type: 'individual', name: 'Station', category: '' } });
		const input = wrapper.find('[role=dialog] input'); expect(wrapper.vm.$refs.bookmarkNameInput).toBe(input.element);
		await input.setValue('New station'); expect(wrapper.vm.bookmarkModal.name).toBe('New station');
		await wrapper.find('.bookmark-overlay').trigger('click'); expect(wrapper.vm.bookmarkModal.show).toBe(false);
	});
	it('updates numeric gain switches and keeps client locks read-only', async () => {
		wrapper = mount(ReceiverView, { attachTo: document.body });
		await wrapper.setData({
			connected: true, remoteMode: 'client',
			deviceCapabilities: { deviceType: 'hackrf', sampleRates: [2000000], gainControls: [{ name: 'Amp', type: 'toggle' }] },
			gains: { Amp: 0 }, locks: { centerFreq: true, sampleRate: true, Amp: false },
		});
		await wrapper.find('.checkbox input').setValue(true); expect(wrapper.vm.gains.Amp).toBe(1);
		await wrapper.find('.lock-btn').trigger('click'); expect(wrapper.vm.locks.centerFreq).toBe(true);
	});
});
