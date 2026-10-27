import { describe, expect, it } from 'vitest';
import { signalBand } from '@/worker/decoders/rtk/signals';
import { gnssSummary } from '@/app/decoders/rtk/signal-summary';

const observation = (constellation, cells) => ({
	constellation,
	cnrDbHz: cells.map((cell) => cell[2]),
	measurements: cells.map(([satellite, signal, cnrDbHz]) => ({ satellite, signal, cnrDbHz, ...signalBand(constellation, signal) })),
});

describe('GNSS frequency groups and quality', () => {
	it('counts active satellite cells once per group while allowing L1/L2 overlap', () => {
		const result = gnssSummary([
			observation('GPS', [
				[1, 2, 42],
				[1, 3, 40],
				[1, 10, 41],
				[3, 10, 39],
				[5, 23, 40],
			]),
			observation('BeiDou', [
				[1, 2, 40],
				[1, 30, 40],
				[1, 14, 40],
				[2, 8, 40],
				[3, 2, 0],
			]),
		]);
		expect(result).toMatchObject({ primary: 3, secondary: 3, quality: 'Good' });
		expect(result.bands).toEqual({
			'GPS L1': 1,
			'GPS L2': 2,
			'GPS L5': 1,
			'BeiDou B1I': 2,
			'BeiDou B1C': 1,
			'BeiDou B2I': 1,
			'BeiDou B3I': 1,
		});
	});

	it('classifies the observed multi-GNSS bands and leaves unknown signals unmapped', () => {
		expect(signalBand('GLONASS', 9)).toEqual({ band: 'G2', group: 'secondary' });
		expect(signalBand('Galileo', 15)).toEqual({ band: 'E5b', group: 'secondary' });
		expect(signalBand('Galileo', 23)).toEqual({ band: 'E5a', group: 'other' });
		expect(signalBand('GPS', 1)).toEqual({});
		expect(signalBand('GPS', 5)).toEqual({});
		expect(gnssSummary([observation('GPS', [[1, 1, 40]])]).primary).toBeUndefined();
	});

	it.each([
		[40, 'Good'],
		[39.9, 'Fair'],
		[30, 'Fair'],
		[29.9, 'Weak'],
	])('rates %s dB-Hz as %s', (strength, quality) => {
		expect(gnssSummary([{ cnrDbHz: [strength, 0] }])).toMatchObject({ meanCnr: strength, quality });
	});

	it('shows unavailable rather than zero satellites or a fix when there are no measurements', () => {
		expect(gnssSummary([])).toMatchObject({ primary: undefined, secondary: undefined, meanCnr: undefined, quality: 'Unavailable' });
		expect(gnssSummary([observation('GPS', [[1, 2, 0]])]).quality).toBe('Unavailable');
		expect(gnssSummary([observation('GPS', [[1, 2, 0]])]).primary).toBe(1);
	});
});
