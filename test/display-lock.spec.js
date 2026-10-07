import { describe, expect, it, vi } from 'vitest';
import { vfoMethods } from '../src/client/app/vfo';
import { zoomMethods } from '../src/client/app/zoom';
import { settingsMethods } from '../src/client/app/settings';
import { makeDefaultVfo } from '../src/client/app/constants';

const receiver = () => ({
	vfos: Array.from({ length: 4 }, () => makeDefaultVfo()),
	radio: { centerFreq: 100 },
	view: { locked: false, autoLockDisabled: false },
	showMsg: vi.fn(),
});

describe('display auto-lock and manual override', () => {
	it('auto-locks at five VFOs, then respects manual unlock on later additions', async () => {
		const app = receiver();
		await vfoMethods.addVfo.call(app);
		expect(app.view.locked).toBe(true);
		zoomMethods.toggleDisplayLock.call(app);
		await vfoMethods.addVfo.call(app);
		await vfoMethods.addVfo.call(app);
		expect(app.view.locked).toBe(false);
		expect(app.showMsg).toHaveBeenCalledTimes(1);
	});

	it('respects manual unlock when the count falls below five and rises again', async () => {
		const app = receiver();
		await vfoMethods.addVfo.call(app);
		zoomMethods.toggleDisplayLock.call(app);
		await vfoMethods.removeVfo.call(app, 4);
		await vfoMethods.addVfo.call(app);
		expect(app.view.locked).toBe(false);
		zoomMethods.toggleDisplayLock.call(app);
		await vfoMethods.addVfo.call(app);
		expect(app.view.locked).toBe(true);
	});

	it('persists the manual override with the saved display settings', async () => {
		const app = receiver();
		await vfoMethods.addVfo.call(app);
		zoomMethods.toggleDisplayLock.call(app);
		const storage = { setItem: vi.fn() };
		vi.stubGlobal('localStorage', storage);
		try {
			settingsMethods.saveSetting.call(app);
			storage.getItem = () => storage.setItem.mock.calls[0][1];
			const restored = { ...receiver(), display: {}, gains: {}, locks: {}, formatFreq: value => value.toFixed(6) };
			settingsMethods.loadSetting.call(restored);
			await vfoMethods.addVfo.call(restored);
			expect(restored.view).toMatchObject({ locked: false, autoLockDisabled: true });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
