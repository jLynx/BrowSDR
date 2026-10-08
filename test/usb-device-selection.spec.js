import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectUsbDevice, usbSettingsKey } from '../src/client/usb-device-selection';
import { createWorkspace } from '../src/client/app/workspace';
import { connectionMethods } from '../src/client/app/connection';
import { settingsMethods } from '../src/client/app/settings';
import { vfoMethods } from '../src/client/app/vfo';
import { createAppData } from '../src/client/app/state';
import * as drivers from '../src/client/sdr-device';

vi.mock('../src/client/worker/wasm-init', () => ({ ensureWasmInitialized: vi.fn(), init: vi.fn() }));
import { Backend } from '../src/client/worker/backend';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const rtl = (serialNumber = '00000001') => ({ vendorId: 0x0bda, productId: 0x2838, serialNumber, productName: 'RTL-SDR' });

function workspaceWithReceiver() {
	vi.stubGlobal('window', { location: { hostname: 'localhost' } });
	const options = createWorkspace({});
	const workspace = { ...options.data(), $nextTick: async () => {} };
	for (const [name, method] of Object.entries(options.methods)) workspace[name] = method.bind(workspace);
	const receiver = id => ({
		receiverId: id, connected: true, running: true, info: { boardName: 'RTL-SDR' },
		$watch: vi.fn(), _connectToDevice: vi.fn(function () { this.connected = true; }), loadSetting: vi.fn(), _initAudioCtx: vi.fn(), showMsg: vi.fn(),
	});
	const first = receiver('local-1');
	workspace.registerReceiver('local-1', first);
	workspace.newReceiver = async () => {
		const id = `local-${workspace.receivers.length + 1}`;
		const app = receiver(id);
		workspace.receivers.push({ id, settingsKey: '' });
		workspace.registerReceiver(id, app);
		return app;
	};
	return { workspace, first };
}

describe('RTL-SDRs with matching USB identities', () => {
	it('keeps the first saved key when an identical dongle is paired and after reloading with fewer devices', () => {
		const storage = new Map();
		vi.stubGlobal('localStorage', { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) });
		const first = rtl(), second = rtl();
		const key = usbSettingsKey(first, [first]);
		storage.set(key, JSON.stringify({ radio: { centerFreq: 96 } }));
		expect(usbSettingsKey(first, [first, second])).toBe(key);
		const otherKey = usbSettingsKey(second, [first, second]);
		expect(otherKey).not.toBe(key);
		storage.set(otherKey, JSON.stringify({ radio: { centerFreq: 435 } }));
		const reloaded = [rtl(), rtl()];
		expect(usbSettingsKey(reloaded[0], reloaded)).toBe(key);
		expect(usbSettingsKey(reloaded[1], reloaded)).toBe(otherKey);
		expect(usbSettingsKey(reloaded[1], [reloaded[1]])).toBe(otherKey);
		const unrelated = rtl('unrelated');
		expect(usbSettingsKey(reloaded[0], [unrelated, ...reloaded])).toBe(key);
	});
	it('migrates previous indexed collision keys without overwriting existing settings', () => {
		const base = 'SDRSetting:usb:3034:10296:00000001';
		const storage = new Map([[`${base}:index-0`, 'first settings'], [`${base}:index-1`, 'second settings']]);
		vi.stubGlobal('localStorage', { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) });
		const devices = [rtl(), rtl()];
		const keys = devices.map(device => usbSettingsKey(device, devices));
		expect(keys[0]).toBe(base);
		expect(keys.map(key => storage.get(key))).toEqual(['first settings', 'second settings']);
		storage.set(base, 'new first settings');
		const reloaded = [rtl(), rtl()];
		usbSettingsKey(reloaded[0], reloaded);
		expect(storage.get(base)).toBe('new first settings');
	});
	it('keeps slots for serial-less devices when unrelated devices change list positions', () => {
		const storage = new Map();
		vi.stubGlobal('localStorage', { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) });
		const devices = [rtl(''), rtl('')];
		const keys = devices.map(device => usbSettingsKey(device, devices));
		const reloaded = [rtl('different'), rtl(''), rtl('')];
		expect(usbSettingsKey(reloaded[1], reloaded)).toBe(keys[0]);
		expect(usbSettingsKey(reloaded[2], reloaded)).toBe(keys[1]);
	});
	it.each(['00000001', ''])('connects two physical dongles with serial "%s" and excludes only the connected object', async serial => {
		const devices = [rtl(serial), rtl(serial)];
		vi.stubGlobal('navigator', { usb: { getDevices: async () => devices, requestDevice: vi.fn() } });
		const { workspace, first } = workspaceWithReceiver();
		first.connected = false;
		await workspace.connectDevice(first, devices[0]);
		first.connected = true;
		expect(workspace.isDeviceConnected(devices[0])).toBe(true);
		expect(workspace.isDeviceConnected(devices[1])).toBe(false);
		const picker = { backend: {}, workspace, _initAudioCtx: vi.fn(), devicePicker: {}, pairNewDevice: vi.fn() };
		await connectionMethods.connect.call(picker);
		expect(picker.devicePicker.devices.map(entry => entry.device)).toEqual([devices[1]]);
		expect(picker.devicePicker.devices[0].deviceNumber).toBe(2);
		await workspace.connectDevice(first, devices[1]);
		expect(workspace.isDeviceConnected(devices[1])).toBe(true);
		expect(workspace.receivers[0].settingsKey).not.toBe(workspace.receivers[1].settingsKey);
		expect(first._connectToDevice).toHaveBeenCalledExactlyOnceWith(devices[0], 0);
		await workspace.connectDevice(first, devices[0]);
		expect(first.showMsg).toHaveBeenCalledWith('This SDR is already connected.');
		expect(workspace.receivers).toHaveLength(2);
	});
	it('selects the exact second dongle even with duplicated VID, PID and serial', () => {
		const devices = [rtl(), rtl()];
		expect(selectUsbDevice(devices, { ...devices[1], deviceIndex: 1 })).toBe(devices[1]);
		expect(() => selectUsbDevice(devices, devices[1])).toThrow('Multiple SDRs match');
		expect(selectUsbDevice(devices, { ...devices[1], deviceIndex: 2 })).toBeUndefined();
		expect(selectUsbDevice(devices, { ...devices[1], productId: 1, deviceIndex: 1 })).toBeUndefined();
	});
	it('opens each exact USB device in a separate backend and keeps their tuning independent', async () => {
		const devices = [rtl(), rtl()];
		vi.stubGlobal('navigator', { usb: { getDevices: async () => devices } });
		const radios = [];
		vi.spyOn(drivers, 'detectDevice').mockReturnValue({ create: () => {
			const radio = { open: vi.fn(), close: vi.fn(), setFrequency: vi.fn() };
			radios.push(radio);
			return radio;
		} });
		const low = new Backend();
		const high = new Backend();
		await low.open({ ...devices[0], deviceIndex: 0 });
		await high.open({ ...devices[1], deviceIndex: 1 });
		expect(radios[0].open).toHaveBeenCalledWith(devices[0]);
		expect(radios[1].open).toHaveBeenCalledWith(devices[1]);
		await low.setFrequency(96);
		await high.setFrequency(435);
		expect(radios[0].setFrequency).toHaveBeenCalledExactlyOnceWith(96000000);
		expect(radios[1].setFrequency).toHaveBeenCalledExactlyOnceWith(435000000);
	});
	it('preserves stable keys for unique serials and existing keys for missing serials', () => {
		const devices = [rtl('blog-v4'), rtl(''), rtl('00000001'), rtl('00000001')];
		expect(usbSettingsKey(devices[0], devices)).toBe('SDRSetting:usb:3034:10296:blog-v4');
		expect(usbSettingsKey(devices[1], devices)).toBe('SDRSetting:usb:3034:10296:index-1');
		expect(usbSettingsKey(devices[2], devices)).not.toBe(usbSettingsKey(devices[3], devices));
		expect(() => usbSettingsKey(rtl(), devices)).toThrow('no longer connected');
	});
});

describe('receiver settings and VFO bandwidth', () => {
	it('does not copy legacy VFOs into an additional SDR; still migrates the first SDR', () => {
		const legacy = JSON.stringify({ radio: { centerFreq: 96, sampleRate: 3200000 }, vfos: [{ freq: 96.1 }, { freq: 435 }] });
		const storage = new Map([['SDRSetting', legacy]]);
		vi.stubGlobal('localStorage', { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) });
		const app = { ...createAppData(), settingsKey: 'SDRSetting:usb:3034:10296:00000001:index-1', formatFreq: freq => freq.toFixed(6) };
		settingsMethods.loadSetting.call(app);
		expect(app.vfos).toHaveLength(1);
		expect(app.radio.centerFreq).toBe(100);
		settingsMethods.loadSetting.call(app, true);
		expect(app.vfos.map(vfo => vfo.freq)).toEqual([96.1, 435]);
		settingsMethods.saveSetting.call(app);
		app.radio.centerFreq = 100;
		settingsMethods.loadSetting.call(app);
		expect(app.radio.centerFreq).toBe(96);
	});
	it('limits VFOs to their own SDR while allowing separate SDRs on distant bands', () => {
		const receiver = center => {
			const app = { radio: { centerFreq: center, sampleRate: 3200000 }, vfos: [{ freq: center }], remoteMode: 'none',
				formatFreq: freq => freq.toFixed(6), updateBackendVfoParams: vi.fn(), updateAllBackendVfoParams: vi.fn() };
			Object.assign(app, vfoMethods);
			return app;
		};
		const low = receiver(96);
		const high = receiver(435);
		low.validateAndApplyVfoFreq(0, 96.1);
		high.validateAndApplyVfoFreq(0, 435.2);
		expect(low.vfoConflictDialog).toBeUndefined();
		expect(high.vfoConflictDialog).toBeUndefined();
		low.vfos.push({ freq: 96.1 });
		low.validateAndApplyVfoFreq(1, 435);
		expect(low.vfoConflictDialog.show).toBe(true);
		expect(high.radio.centerFreq).toBe(435);
	});
});
