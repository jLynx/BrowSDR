import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAllCatalogFilters, lookupDevice } from '@/radio/device-catalog';
import { detectDevice } from '@/radio/sdr-device';
import { connectionMethods } from '@/app/radio/connection';
import '@/devices/airspy';

afterEach(() => vi.unstubAllGlobals());

const airspy = { vendorId: 0x1d50, productId: 0x60a1, productName: 'AIRSPY', serialNumber: 'AIRSPY SN:62CC68FF3587915B' };

describe('Airspy browser pairing', () => {
	it('keeps the tester USB identity in both the chooser catalog and worker driver', () => {
		expect(getAllCatalogFilters()).toContainEqual({ vendorId: airspy.vendorId, productId: airspy.productId });
		expect(lookupDevice(airspy)?.type).toBe('airspy');
		expect(detectDevice(airspy)?.type).toBe('airspy');
	});
	it('passes the Airspy filter to the native chooser and connects the selected device', async () => {
		const requestDevice = vi.fn(async () => airspy);
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn(async () => []), requestDevice } });
		const receiver = { devicePicker: { show: true }, connectToDevice: vi.fn(), showMsg: vi.fn() };
		await connectionMethods.pairNewDevice.call(receiver);
		expect(requestDevice).toHaveBeenCalledOnce();
		expect(requestDevice.mock.calls[0][0].filters).toContainEqual({ vendorId: airspy.vendorId, productId: airspy.productId });
		expect(receiver.connectToDevice).toHaveBeenCalledExactlyOnceWith(airspy);
	});
	it('lists an already-paired Airspy when Add SDR is opened', async () => {
		vi.stubGlobal('navigator', { usb: { getDevices: vi.fn(async () => [airspy]), requestDevice: vi.fn() } });
		const receiver = { backend: {}, devicePicker: {}, _initAudioCtx: vi.fn(), showMsg: vi.fn() };
		await connectionMethods.connect.call(receiver);
		expect(receiver.devicePicker.show).toBe(true);
		expect(receiver.devicePicker.devices).toHaveLength(1);
		expect(receiver.devicePicker.devices[0].device).toBe(airspy);
		expect(receiver.devicePicker.devices[0].driverName).toBe('Airspy');
	});
});
