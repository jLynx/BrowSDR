import { describe, expect, it } from 'vitest';
import { planSharedBands } from '../src/client/worker/channel-plan';

const frequencies = [89.4, 88.6, 90.212, 91.018, 91.805, 92.593, 93.398, 89, 93.793, 94.213, 94.989, 95.812, 96.601, 97.394, 98.204, 98.991, 99.788, 100.619, 101.407];
const params = frequencies.map(freq => ({ freq, enabled: true, mode: 'wfm', bandwidth: 150000, pocsag: false }));

describe('shared VFO band planning', () => {
	it('routes all nineteen WFM VFOs into safe narrower bands', () => {
		const plan = planSharedBands(61440000, 95, params, true);
		expect(plan.ratio).toBe(32);
		expect(plan.sampleRate).toBe(1920000);
		expect(plan.direct).toEqual([]);
		expect(plan.bands.flatMap(band => band.vfos).sort((left, right) => left - right)).toEqual(params.map((_, index) => index));
		expect(plan.bands.length).toBeLessThan(19);
		for (const band of plan.bands) {
			for (const index of band.vfos) expect(Math.abs((params[index].freq - band.centerFreq) * 1e6) + 125000).toBeLessThanOrEqual(plan.sampleRate * 0.35);
		}
	});
	it.each([1000000, 2000000])('keeps low input rate %i on the direct path', sampleRate => {
		expect(planSharedBands(sampleRate, 95, params, true).bands).toEqual([]);
	});
	it('supports disabling the feature and avoids overhead with fewer than three VFOs', () => {
		expect(planSharedBands(61440000, 95, params, false).direct).toHaveLength(19);
		expect(planSharedBands(61440000, 95, params.slice(0, 2), true).bands).toEqual([]);
	});
	it('falls back individually for wide channels and receiver edges', () => {
		const values = [...params, { ...params[0], mode: 'raw', bandwidth: 4000000 }, { ...params[0], freq: 125.6 }];
		expect(planSharedBands(61440000, 95, values, true).direct).toEqual([19, 20]);
	});
	it('updates routes for tuning, muting, and independent pager reception', () => {
		const values = params.map(value => ({ ...value }));
		values[0].enabled = false;
		values[1].enabled = false;
		values[1].pocsag = true;
		values[2].freq = 102;
		const routed = planSharedBands(61440000, 95, values, true).bands.flatMap(band => band.vfos);
		expect(routed).not.toContain(0);
		expect(routed).toContain(1);
		expect(routed).toContain(2);
		values[0].enabled = true;
		expect(planSharedBands(61440000, 95, values, true).bands.flatMap(band => band.vfos)).toContain(0);
	});
});
