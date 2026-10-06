import { describe, expect, it } from 'vitest';
import { normalizeSpectrumFps, spectrumSmoothingAlpha, WaterfallClock } from '../src/client/spectrum-rate';
import { settingsMethods } from '../src/client/app/settings';

describe('spectrum update rate', () => {
	it.each([20, 30, 60])('preserves the supported target %i', value => {
		expect(normalizeSpectrumFps(value)).toBe(value);
	});
	it.each([undefined, null, '', '60', 0, 120, NaN])('defaults invalid or missing settings to 20 FPS (%s)', value => {
		expect(normalizeSpectrumFps(value)).toBe(20);
	});
	it.each([60, 120])('loads and validates a persisted display target (%i)', value => {
		const context = {
			display: { spectrumFps: 20 },
			vfos: [],
		};
		const originalStorage = globalThis.localStorage;
		globalThis.localStorage = { getItem: () => JSON.stringify({ display: { spectrumFps: value } }) };
		try {
			settingsMethods.loadSetting.call(context);
			expect(context.display.spectrumFps).toBe(value === 60 ? 60 : 20);
		} finally {
			globalThis.localStorage = originalStorage;
		}
	});
});

describe('time-based spectrum display', () => {
	it.each([20, 30, 60])('advances 20 waterfall rows per second at %i FPS', fps => {
		const clock = new WaterfallClock();
		expect(clock.advance(0)).toEqual({ rows: 1, fraction: 0 });
		let rows = 0;
		for (let frame = 1; frame <= fps * 10; frame++) {
			const step = clock.advance(frame * 1000 / fps);
			rows += step.rows;
			expect(step.fraction).toBeGreaterThanOrEqual(0);
			expect(step.fraction).toBeLessThan(1);
		}
		expect(rows).toBe(200);
	});
	it('keeps fractional progress across live FPS changes and jitter', () => {
		const clock = new WaterfallClock();
		clock.advance(0);
		expect(clock.advance(20)).toEqual({ rows: 0, fraction: 0.4 });
		expect(clock.advance(50)).toEqual({ rows: 1, fraction: 0 });
		expect(clock.advance(175)).toEqual({ rows: 2, fraction: 0.5 });
		expect(clock.advance(200)).toEqual({ rows: 1, fraction: 0 });
	});
	it('does not fabricate a large history burst after suspension', () => {
		const clock = new WaterfallClock();
		clock.advance(0);
		clock.advance(25);
		expect(clock.advance(30000)).toEqual({ rows: 1, fraction: 0 });
		expect(clock.advance(30025)).toEqual({ rows: 0, fraction: 0.5 });
	});
	it.each([20, 30, 60])('preserves the spectrum step response at %i FPS', fps => {
		let remaining = 1;
		for (let frame = 0; frame < fps; frame++) {
			remaining *= 1 - spectrumSmoothingAlpha(1000 / fps);
		}
		expect(remaining).toBeCloseTo(Math.pow(0.4, 20), 12);
	});
	it('matches the original 20 FPS smoothing and handles pauses', () => {
		expect(spectrumSmoothingAlpha(50)).toBeCloseTo(0.6);
		expect(spectrumSmoothingAlpha(0)).toBe(0);
		expect(spectrumSmoothingAlpha(-1)).toBe(0);
		expect(spectrumSmoothingAlpha(30000)).toBe(1);
	});
});
