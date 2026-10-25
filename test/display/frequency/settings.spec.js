import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsMethods } from '@/app/radio/settings';
import { connectionMethods } from '@/app/radio/connection';
import { createAppData } from '@/app/core/state';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
function receiver() {
	vi.stubGlobal('navigator', { onLine: true });
	return createAppData();
}

describe('saved and stopped receiver tuning', () => {
	it('removes negative RF frequencies from old saved settings', () => {
		vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ radio: { centerFreq: -0.2 }, vfos: [{ freq: -0.859 }] }) });
		const app = receiver();
		settingsMethods.loadSetting.call(app);
		expect(app.radio.centerFreq).toBe(0);
		expect(app.vfos[0].freq).toBe(0);
		expect(app.vfos[0].displayFreq).toBe('000.000000');
	});
	it('retains low RF tuning with a negative upconverter shift on reload', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => JSON.stringify({ radio: { centerFreq: 0.2, frequencyShift: -125 }, vfos: [{ freq: 0.859 }] }),
		});
		const app = receiver();
		settingsMethods.loadSetting.call(app);
		expect(app.radio).toMatchObject({ centerFreq: 0.2, frequencyShift: -125 });
		expect(app.vfos[0].freq).toBe(0.859);
	});
	it('restores the previous working frequency when starting at an unsupported frequency fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const app = Object.assign(receiver(), {
			_confirmedTuning: { centerFreq: 131.55, frequencyShift: 0 },
			backend: { startRxStream: vi.fn().mockRejectedValue(new Error('SX: cannot tune to 0.200 MHz')), stopRx: vi.fn() },
			_initAudioCtx: vi.fn(),
			_resetAudioPlayback: vi.fn(),
			_prepareAudioWorklet: vi.fn(),
			initCanvas: vi.fn(),
			applyZoomToEngine: vi.fn(),
			saveSetting: vi.fn(),
			showMsg: vi.fn(),
		});
		app.radio.centerFreq = 0.2;
		await connectionMethods.startStream.call(app);
		expect(app.running).toBe(false);
		expect(app.radio.centerFreq).toBe(131.55);
		expect(app.showMsg).toHaveBeenCalledWith(expect.stringContaining('Restored the previous frequency'));
	});
});
