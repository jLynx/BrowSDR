import { describe, expect, it } from 'vitest';
import { correctionAge } from '@/app/decoders/rtk/reception';

describe('RTK correction age', () => {
	it.each([
		[0, '0 s ago'],
		[59000, '59 s ago'],
		[60000, '1 m 0 s ago'],
		[3599000, '59 m 59 s ago'],
		[3600000, '1 h 0 m ago'],
		[86400000, '1 d 0 h ago'],
	])('formats an elapsed time of %i ms', (elapsed, expected) => {
		expect(correctionAge(1000, 1000 + elapsed)).toBe(expected);
	});
	it('distinguishes missing timestamps and clamps a future timestamp to zero', () => {
		expect(correctionAge(undefined, 1000)).toBe('No verified corrections yet');
		expect(correctionAge(NaN, 1000)).toBe('No verified corrections yet');
		expect(correctionAge(2000, 1000)).toBe('0 s ago');
	});
});
