import { describe, expect, it } from 'vitest';
import { ft8SourceIndices, ft8SourceUnavailable } from '../src/client/ft8/sources';

const frequencies = [1.840, 3.573, 7.074, 10.136, 14.074, 18.100, 21.074, 24.915, 28.074];
const vfos = frequencies.map(freq => ({ freq, mode: 'usb', enabled: false }));

describe('FT8 source coverage', () => {
	it('includes all nine muted 160 to 10 m VFOs in a 30.72 MSPS capture', () => {
		expect(ft8SourceIndices('all', vfos, 14.96, 30720000)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});
	it('excludes bands outside capture or in another mode and supports individual selection', () => {
		expect(ft8SourceIndices('all', vfos, 14.074, 2000000)).toEqual([4]);
		expect(ft8SourceIndices('4', vfos, 14.96, 30720000)).toEqual([4]);
		expect(ft8SourceIndices('all', [{ freq: 14.074, mode: 'lsb' }], 14.074, 2000000)).toEqual([]);
	});
	it('requires the full USB passband to fit at the capture edge', () => {
		expect(ft8SourceUnavailable({ freq: 14.9971, mode: 'usb' }, 14, 2000000)).toBe('Outside receiver bandwidth');
		expect(ft8SourceUnavailable({ freq: 14.9969, mode: 'usb' }, 14, 2000000)).toBe('');
	});
});
