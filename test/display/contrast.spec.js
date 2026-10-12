import { describe, expect, it } from 'vitest';
import { autoContrastRange, displayRange, validContrastRange } from '@/display/contrast';

describe('waterfall contrast', () => {
	it('follows a wider-band noise floor without being driven by a single spike', () => {
		const data = new Float32Array(65536).fill(-85);
		data[0] = 0;
		const original = autoContrastRange(data);
		data.fill(-79);
		data[0] = 0;
		const wider = autoContrastRange(data);
		expect(wider.minDB - original.minDB).toBe(6);
		expect(wider.maxDB - original.maxDB).toBe(6);
		expect(original.maxDB).toBe(-40);
	});
	it('ignores silent and invalid frames', () => {
		expect(autoContrastRange(new Float32Array([NaN, -200, -Infinity]))).toBeNull();
	});
	it('retains manual bounds when automatic contrast is disabled', () => {
		const display = { minDB: -110, maxDB: -55 };
		expect(displayRange(display)).toEqual({ minDB: -110, maxDB: -55 });
		expect(display).toEqual({ minDB: -110, maxDB: -55 });
	});
	it('keeps invalid or crossing ranges finite and ordered', () => {
		for (const pair of [
			[-50, -100],
			[NaN, Infinity],
			[0, 0],
		]) {
			const range = validContrastRange(...pair);
			expect(Number.isFinite(range.minDB + range.maxDB)).toBe(true);
			expect(range.maxDB).toBeGreaterThan(range.minDB);
		}
	});
});
