import { describe, expect, it } from 'vitest';
import { surveyPlan } from '@/worker/decoders/rtk/discovery/plan';

describe('RTK range discovery planning', () => {
	it('covers arbitrary channel centres, including both edges, without leaving the requested range', () => {
		const plan = surveyPlan(919.123, 919.361, 2000000, 919.25);
		expect(plan[0].frequencyMHz).toBe(919.123);
		expect(plan.at(-1).frequencyMHz).toBe(919.361);
		for (let i = 1; i < plan.length; i++) expect(plan[i].frequencyMHz - plan[i - 1].frequencyMHz).toBeLessThanOrEqual(0.05);
	});
	it('visits measured NZ hop channels for a full lap before sweeping other frequencies', () => {
		const plan = surveyPlan(915, 928, 20000000, 923.118);
		expect(plan.slice(0, 4).map((channel) => channel.frequencyMHz)).toEqual([923.118, 915.401, 921.401, 921.791]);
		expect(plan[1].seconds).toBeGreaterThan(15);
		expect(plan[3].seconds).toBeGreaterThan(18);
		expect(new Set(plan.map((channel) => channel.frequencyMHz)).size).toBe(plan.length);
	});
	it.each([
		[928, 915],
		[899, 915],
		[915, 931],
		[NaN, 928],
	])('rejects invalid range %s–%s', (start, end) => {
		expect(() => surveyPlan(start, end, 20000000, 923.118)).toThrow('ordered RTK frequency range');
	});
	it('rejects a range outside the recording rather than retuning or silently clipping it', () => {
		expect(() => surveyPlan(915, 928, 2000000, 923.118)).toThrow('entire discovery range');
		expect(() => surveyPlan(923, 923.2, 500000, 923.118)).toThrow('1 MSPS');
		expect(surveyPlan(923.118, 923.118, 1000000, 923.118)).toHaveLength(1);
	});
});
