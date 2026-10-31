import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('Add SDR without available paired hardware', () => {
	const sdr = { vendorId: 0x04b4, productId: 0x00f1, productName: 'LimeSDR' };
	it.each([{ paired: [] }, { paired: [{ vendorId: 1, productId: 2 }] }])(
		'opens the native USB picker directly in production for %o',
		async ({ paired }) => {
			vi.stubEnv('DEV', false);
			vi.stubGlobal('isSecureContext', true);
			const requestDevice = vi.fn().mockResolvedValue(sdr),
				connectDevice = vi.fn();
			vi.stubGlobal('navigator', {
				usb: { getDevices: vi.fn().mockResolvedValue(paired), requestDevice },
				userActivation: { isActive: true },
			});
			const wrapper = mount(ReceiverView);
			await wrapper.setData({ backend: {}, workspace: { isDeviceConnected: () => false, connectDevice } });
			vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
			await wrapper.vm.connect();
			expect(requestDevice).toHaveBeenCalledWith({ filters: expect.any(Array) });
			expect(connectDevice).toHaveBeenCalledWith(wrapper.vm, sdr);
			expect(wrapper.vm.devicePicker.show).toBe(false);
			wrapper.unmount();
		},
	);
	it.each([true, false])('shows the paired-device picker with active gesture %s when an SDR is available', async (active) => {
		vi.stubEnv('DEV', false);
		vi.stubGlobal('isSecureContext', true);
		const requestDevice = vi.fn();
		vi.stubGlobal('navigator', {
			usb: { getDevices: vi.fn().mockResolvedValue([sdr]), requestDevice },
			userActivation: { isActive: active },
		});
		const wrapper = mount(ReceiverView);
		await wrapper.setData({ backend: {} });
		vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
		await wrapper.vm.connect();
		expect(requestDevice).not.toHaveBeenCalled();
		expect(wrapper.vm.devicePicker.devices).toHaveLength(1);
		expect(wrapper.vm.devicePicker.show).toBe(true);
		wrapper.unmount();
	});
	it('keeps development test receivers reachable without a USB prompt', async () => {
		vi.stubEnv('DEV', true);
		vi.stubGlobal('isSecureContext', true);
		const requestDevice = vi.fn();
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn().mockResolvedValue([]), requestDevice } });
		const wrapper = mount(ReceiverView);
		await wrapper.setData({ backend: {} });
		vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
		await wrapper.vm.connect();
		expect(requestDevice).not.toHaveBeenCalled();
		expect(wrapper.get('[role=dialog]').text()).toContain('Mock SDR');
		expect(wrapper.get('[role=dialog]').text()).toContain('IQ File Replay');
		wrapper.unmount();
	});
	it('falls back to the explicit pairing button if the user gesture has expired', async () => {
		vi.stubEnv('DEV', false);
		vi.stubGlobal('isSecureContext', true);
		const requestDevice = vi.fn().mockRejectedValue(Object.assign(new Error('Cancelled'), { name: 'NotFoundError' }));
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn().mockResolvedValue([]), requestDevice }, userActivation: { isActive: false } });
		const wrapper = mount(ReceiverView);
		await wrapper.setData({ backend: {} });
		vi.spyOn(wrapper.vm, '_initAudioCtx').mockImplementation(() => {});
		const showMsg = vi.spyOn(wrapper.vm, 'showMsg').mockImplementation(() => {});
		await wrapper.vm.connect();
		expect(requestDevice).not.toHaveBeenCalled();
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Pair New Device')!
			.trigger('click');
		expect(requestDevice).toHaveBeenCalledOnce();
		expect(showMsg).not.toHaveBeenCalled();
		wrapper.unmount();
	});
});
