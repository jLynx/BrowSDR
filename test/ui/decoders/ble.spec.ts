import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type ComponentPublicInstance } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { BleMessage } from '@/worker/decoders/ble/types';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.vm.stopBleScan();
	wrapper?.unmount();
	vi.useRealTimers();
});
const message = (channel = 37): BleMessage => ({
	type: 'ble',
	freq: channel === 37 ? 2402 : 2480,
	status: { state: 'receiving', message: 'Listening', samples: 2000000, frames: 1 },
	advertisements: [
		{
			address: 'C6:05:04:03:02:01',
			addressType: 'random',
			pduType: 'ADV_IND',
			channel,
			name: 'TEST SENSOR',
			completeName: true,
			services: ['180F'],
			serviceData: [],
			manufacturer: 0x4c,
			manufacturerData: '1234',
			data: '1234',
			signalDbfs: -24,
		},
	],
});

async function setup() {
	wrapper = mount(ReceiverView);
	wrapper.vm.saveSetting = vi.fn();
	await wrapper.setData({
		running: true,
		connected: true,
		backend: { setVfoParams: vi.fn(), setFrequency: vi.fn().mockResolvedValue(undefined) },
		vfos: [{ ...makeDefaultVfo(2402), ble: true }],
		ble: { panelOpen: true, tuning: false, scanning: false, scanVfo: null, status: [], devices: [], message: '' },
	});
}

describe('BLE receiver tools', () => {
	it('keeps telemetry out of receiver and VFO control renders, shows names, search and raw details', async () => {
		let receiverUpdates = 0,
			vfoUpdates = 0;
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
		await wrapper.setData({ running: true, vfos: [{ ...makeDefaultVfo(2402), ble: true }], ble: { ...wrapper.vm.ble, panelOpen: true } });
		receiverUpdates = vfoUpdates = 0;
		for (let i = 0; i < 3; i++) {
			wrapper.vm._onBleMessage(0, 2402, message());
			await nextTick();
		}
		expect(wrapper.get('.ble-panel tbody').text()).toContain('TEST SENSOR');
		expect(wrapper.get('.ble-panel tbody').text()).toContain('Apple');
		expect(receiverUpdates).toBe(0);
		expect(vfoUpdates).toBe(0);
		await wrapper.get('input[aria-label="Search BLE devices"]').setValue('no match');
		expect(wrapper.text()).toContain('No devices match');
		await wrapper.get('input[aria-label="Search BLE devices"]').setValue('TEST');
		await wrapper.get('.ble-panel tbody button').trigger('click');
		expect(wrapper.get('[aria-label="BLE device details"]').text()).toContain('180F');
		await wrapper.get('button[aria-label="Close BLE panel"]').trigger('click');
		expect(wrapper.vm.vfos[0].ble).toBe(true);
	});
	it('merges channels, rejects old tuning messages and expires devices', async () => {
		vi.useFakeTimers();
		await setup();
		wrapper.vm._onBleMessage(0, 2402, message());
		wrapper.vm.vfos[0].freq = 2480;
		wrapper.vm._onBleMessage(0, 2402, message());
		wrapper.vm._onBleMessage(0, 2480, message(39));
		await nextTick();
		expect(wrapper.vm.ble.devices[0]).toMatchObject({ channels: [37, 39], packets: 2 });
		await vi.advanceTimersByTimeAsync(301000);
		expect(wrapper.findAll('.ble-panel tbody tr')).toHaveLength(0);
	});
	it('cycles the same VFO on all channels and stops without another tune', async () => {
		vi.useFakeTimers();
		await setup();
		await wrapper.vm.startBleScan();
		expect(wrapper.vm.ble.message).toBe('');
		expect(wrapper.vm.ble.scanning).toBe(true);
		expect(wrapper.vm.vfos[0]).toMatchObject({ enabled: false, ble: true, freq: 2402 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.vm.vfos[0].freq).toBe(2426);
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.vm.vfos[0].freq).toBe(2480);
		await vi.advanceTimersByTimeAsync(1000);
		expect(wrapper.vm.vfos[0].freq).toBe(2402);
		wrapper.vm.stopBleScan();
		await vi.advanceTimersByTimeAsync(4000);
		expect(wrapper.vm.backend.setFrequency).toHaveBeenCalledTimes(4);
		expect(wrapper.vm.vfos[0].ble).toBe(false);
	});
	it('does not start scans with frequency locks, insufficient rate or an unsupported tuner', async () => {
		await setup();
		for (const patch of [
			{ locks: { centerFreq: true } },
			{ locks: { centerFreq: false }, radio: { ...wrapper.vm.radio, sampleRate: 1000000 } },
			{ radio: { ...wrapper.vm.radio, sampleRate: 8000000 }, deviceCapabilities: { deviceType: 'rtlsdr' } },
		]) {
			await wrapper.setData(patch);
			await wrapper.vm.startBleScan();
			expect(wrapper.vm.ble.scanning).toBe(false);
		}
		expect(wrapper.vm.backend.setFrequency).not.toHaveBeenCalled();
	});
	it('does not re-enable or reschedule a cancelled scan while a tune is pending', async () => {
		vi.useFakeTimers();
		await setup();
		await wrapper.vm.startBleScan();
		let complete!: () => void;
		wrapper.vm.backend.setFrequency.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
		);
		await vi.advanceTimersByTimeAsync(1000);
		wrapper.vm.stopBleScan();
		complete();
		await nextTick();
		await nextTick();
		await vi.advanceTimersByTimeAsync(4000);
		expect(wrapper.vm.ble.scanning).toBe(false);
		expect(wrapper.vm.vfos[0].ble).toBe(false);
		expect(wrapper.vm.backend.setFrequency).toHaveBeenCalledTimes(2);
	});
});
