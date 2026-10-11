import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPECTRUM_RANGE, normalizedSpectrumRange, SPECTRUM_RANGE_VERSION } from '@/display/spectrum-range';
import { settingsMethods } from '@/app/radio/settings';
import { createAppData } from '@/app/core/state';
import { convertDecibelToRGB, WaterfallGL, Waterfall } from '@/display/utils';

afterEach(() => vi.unstubAllGlobals());

function receiver() {
	vi.stubGlobal('navigator', { onLine: true });
	return createAppData();
}

describe('normalized spectrum display range', () => {
	it('restores saved gains, their device type and muted VFOs on reload', () => {
		const storage = new Map();
		vi.stubGlobal('localStorage', { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) });
		const app = receiver();
		app.gains = { LNA: 32, VGA: 22, 'Amp (14dB)': 0 };
		app.gainDeviceType = 'hackrf';
		app.vfos[0].enabled = false;
		settingsMethods.saveSetting.call(app);
		const restored = receiver();
		settingsMethods.loadSetting.call(restored);
		expect(restored.gains).toEqual(app.gains);
		expect(restored.gainDeviceType).toBe('hackrf');
		expect(restored.vfos[0].enabled).toBe(false);
	});
	it('gives new receivers corrected default bounds', () => {
		expect(receiver().display).toMatchObject(DEFAULT_SPECTRUM_RANGE);
		expect(DEFAULT_SPECTRUM_RANGE.minDB).toBeCloseTo(-118.1648, 4);
		expect(DEFAULT_SPECTRUM_RANGE.maxDB).toBeCloseTo(-48.1648, 4);
	});

	it.each([8192, 65536])('migrates saved custom bounds at FFT size %i exactly once', (fftSize) => {
		const storage = new Map([['SDRSetting', JSON.stringify({ radio: { fftSize }, display: { minDB: -65, maxDB: -5 } })]]);
		vi.stubGlobal('localStorage', { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) });
		const app = receiver();
		settingsMethods.loadSetting.call(app);
		const expected = normalizedSpectrumRange(fftSize, -65, -5);
		expect(app.display).toMatchObject(expected);
		settingsMethods.loadSetting.call(app);
		expect(app.display).toMatchObject(expected);
		settingsMethods.saveSetting.call(app);
		expect(JSON.parse(storage.get('SDRSetting')).spectrumRangeVersion).toBe(SPECTRUM_RANGE_VERSION);
		const restored = receiver();
		settingsMethods.loadSetting.call(restored);
		expect(restored.display).toMatchObject(expected);
	});

	it('keeps new defaults when an old save omits bounds', () => {
		vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ display: { spectrumFps: 60, minDB: null } }) });
		const app = receiver();
		settingsMethods.loadSetting.call(app);
		expect(app.display).toMatchObject({ ...DEFAULT_SPECTRUM_RANGE, spectrumFps: 60 });
	});

	it.each([8192, 65536])('preserves waterfall colours and spectrum height at FFT size %i', (fftSize) => {
		const range = normalizedSpectrumRange(fftSize);
		const offset = 10 * Math.log10(fftSize);
		for (const oldLevel of [-85, -70, -60, -45, -30, -15, 0, 10]) {
			const level = oldLevel - offset;
			expect(convertDecibelToRGB(level, range.minDB, range.maxDB)).toEqual(convertDecibelToRGB(oldLevel, -70, 0));
			expect((level - range.minDB) / (range.maxDB - range.minDB)).toBeCloseTo((oldLevel + 70) / 70, 12);
		}
	});

	it.each([WaterfallGL, Waterfall])('applies migrated colours in both waterfall renderers (%s)', (Renderer) => {
		const engine = Object.create(Renderer.prototype);
		const pixels = new Uint8Array(12);
		const ctx = { drawImage: vi.fn(), getImageData: () => ({ data: pixels }), putImageData: vi.fn() };
		Object.assign(engine, {
			bandSize: 3,
			historySize: 512,
			data: pixels,
			_current: 0,
			offscreen: { width: 3, height: 512 },
			offCtx: ctx,
			preview: { getContext: () => ctx },
			render: vi.fn(),
			gl: { bindTexture: vi.fn(), texSubImage2D: vi.fn() },
			textures: [],
		});
		engine.setRange(DEFAULT_SPECTRUM_RANGE.minDB, DEFAULT_SPECTRUM_RANGE.maxDB);
		engine.renderLine([-60, -40, -20].map((level) => level - 10 * Math.log10(65536)));
		for (const [i, level] of [-60, -40, -20].entries()) {
			const { r, g, b } = convertDecibelToRGB(level, -70, 0);
			expect(Array.from(pixels.slice(i * 4, i * 4 + 3))).toEqual([r, g, b]);
		}
	});
});
