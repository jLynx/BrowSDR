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
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('receiver uses the shared UI', () => {
	it('shows source loss separately from DSP drops and playback gaps', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			showStats: true,
			dspStats: {
				usbFps: 470,
				audioFps: 470,
				audioRate: 48000,
				inputRate: 61440000,
				dspAvgMs: 1.5,
				dspMaxMs: 2,
				dropped: 0,
				droppedTotal: 0,
				chunkSize: 261120,
				sourceGapCount: 2,
				sourceMissingSamples: 2040,
				sourceDiscontinuities: 0,
			},
		});
		const overlay = wrapper.find('.dsp-stats-overlay');
		expect(overlay.findComponent(components.UiButton).props('variant')).toBe('secondary');
		expect(overlay.text()).toContain('IQ drops: 0 total');
		expect(overlay.text()).toContain('Source gaps: 2 total');
		expect(overlay.text()).toContain('Playback gaps: 0 total');
		expect(overlay.text()).not.toContain('Missing:');
		expect(overlay.text()).not.toContain('calls/s');
		await overlay.get('button').trigger('click');
		expect(overlay.get('button').attributes('aria-expanded')).toBe('true');
		expect(overlay.text()).toContain('Missing: 2040 samples | Discontinuities: 0');
		await overlay.get('button').trigger('click');
		expect(overlay.find('.dsp-stats-details').exists()).toBe(false);
	});
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
		vi.stubEnv('DEV', true);
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
	it('hides Mock SDR and prevents mock connections in production', async () => {
		vi.stubEnv('DEV', false);
		vi.stubGlobal('isSecureContext', true);
		wrapper = mount(ReceiverView);
		await wrapper.vm.connect();
		expect(wrapper.get('[role=dialog]').text()).not.toContain('Mock SDR');
		expect(wrapper.findAll('button').some((button) => button.text() === 'Pair New Device')).toBe(true);
		const connectDevice = vi.fn();
		const open = vi.fn();
		await wrapper.setData({ workspace: { connectDevice }, backend: { open } });
		await wrapper.vm.connectMock();
		await wrapper.vm._connectMock();
		expect(connectDevice).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
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
	it('requires stopped reception to change the USB format and keeps the saved numeric choice', async () => {
		wrapper = mount(ReceiverView, { attachTo: document.body });
		await wrapper.setData({
			connected: true,
			running: true,
			deviceCapabilities: {
				deviceType: 'limesdr',
				sampleRates: [61440000],
				gainControls: [{ name: 'USB Format', type: 'select', labels: ['16-bit', 'Packed 12-bit'] }],
			},
			gains: { 'USB Format': 0 },
		});
		const format = wrapper.get('select[aria-label="USB Format"]');
		expect(wrapper.get('.radio-advanced').findComponent(components.UiPanelHeader).props('label')).toBe('Advanced');
		expect(wrapper.get('.radio-advanced .panel-body').isVisible()).toBe(false);
		await wrapper.get('.radio-advanced [role=button]').trigger('keydown', { key: 'Enter' });
		expect(wrapper.vm.radioAdvanced).toBe(true);
		expect(wrapper.get('.radio-advanced .panel-body').isVisible()).toBe(true);
		expect(format.attributes('disabled')).toBeDefined();
		await wrapper.setData({ running: false });
		expect(format.attributes('disabled')).toBeUndefined();
		await format.setValue('1');
		expect(wrapper.vm.gains['USB Format']).toBe(1);
		await wrapper.setData({ running: true });
		expect(format.attributes('disabled')).toBeDefined();
		expect(wrapper.vm.gains['USB Format']).toBe(1);
	});
	it('labels USB-only reception, locks mode while running, and omits playback results', async () => {
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			connected: true,
			running: true,
			showStats: true,
			showStatsDetails: true,
			deviceCapabilities: {
				deviceType: 'limesdr',
				sampleRates: [61440000],
				gainControls: [{ name: 'Receive Mode', type: 'select', labels: ['Normal', 'USB only (diagnostic)'] }],
			},
			gains: { 'Receive Mode': 1 },
			dspStats: {
				usbDiagnosticMode: 1,
				usbTransferCount: 470,
				usbElapsedMs: 1000,
				usbReceivedBytes: 184811520,
				sourceGapCount: 0,
				sourceMissingSamples: 0,
			},
		});
		expect(wrapper.get('select[aria-label="Receive Mode"]').attributes('disabled')).toBeDefined();
		expect(wrapper.find('.dsp-stats-overlay').text()).toContain('USB-only diagnostic');
		expect(wrapper.find('.dsp-stats-overlay').text()).toContain('470 transfers');
		expect(wrapper.find('.dsp-stats-overlay').text()).not.toContain('Playback gaps');
		expect(wrapper.find('.active-audio-overlay').exists()).toBe(false);
		expect(wrapper.vm.autoGainSupported()).toBe(false);
		vi.stubGlobal(
			'AudioContext',
			vi.fn(() => {
				throw new Error('USB diagnostic initialized audio');
			}),
		);
		wrapper.vm._initAudioCtx();
		expect(AudioContext).not.toHaveBeenCalled();
		await wrapper.setData({ running: false });
		expect(wrapper.get('select[aria-label="Receive Mode"]').attributes('disabled')).toBeUndefined();
	});
	it('hides diagnostic reception in production and remote sessions, retaining advanced USB format', async () => {
		vi.stubEnv('DEV', false);
		wrapper = mount(ReceiverView);
		await wrapper.setData({
			deviceCapabilities: {
				deviceType: 'limesdr',
				gainControls: [
					{ name: 'USB Format', type: 'select', labels: ['16-bit', 'Packed 12-bit'] },
					{ name: 'Receive Mode', type: 'select', labels: ['Normal', 'USB only (diagnostic)'] },
				],
			},
		});
		expect(wrapper.find('select[aria-label="Receive Mode"]').exists()).toBe(false);
		expect(wrapper.find('select[aria-label="USB Format"]').exists()).toBe(true);
		vi.stubEnv('DEV', true);
		await wrapper.setData({ remoteMode: 'client' });
		expect(wrapper.find('select[aria-label="Receive Mode"]').exists()).toBe(false);
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
