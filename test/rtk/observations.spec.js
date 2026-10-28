import { describe, expect, it } from 'vitest';
import { RtkObservations } from '@/worker/decoders/rtk/observations';
import { gnssSummary } from '@/app/decoders/rtk/signal-summary';
import { signalBand } from '@/worker/decoders/rtk/signals';

function observation(constellation, satellites, multipleMessage, epochMs = 1000, receivedAt = 1000) {
	const signals = constellation === 'BeiDou' ? [2, 25] : [2, 8];
	const measurements = satellites.flatMap((satellite) =>
		signals.map((signal) => ({ satellite, signal, cnrDbHz: 42, ...signalBand(constellation, signal) })),
	);
	return {
		type: 1124,
		stationId: 42,
		constellation,
		epochMs,
		multipleMessage,
		satellites,
		signals,
		measurements,
		cells: measurements.length,
		cnrDbHz: measurements.map((cell) => cell.cnrDbHz),
		receivedAt,
	};
}

describe('RTCM MSM observation sequences', () => {
	it('publishes all constellations together and joins two BeiDou parts without transient totals', () => {
		const assembly = new RtkObservations();
		const ids = (count) => Array.from({ length: count }, (_, i) => i + 1);
		for (const part of [
			observation('GPS', ids(11), true),
			observation('GLONASS', ids(9), true),
			observation('Galileo', ids(8), true),
			observation('BeiDou', ids(12), true),
		])
			expect(assembly.process(part)).toBeUndefined();
		const complete = assembly.process(observation('BeiDou', [13, 14, 15], false));
		expect(complete.BeiDou.satellites).toHaveLength(15);
		expect(complete.BeiDou.cells).toBe(30);
		expect(gnssSummary(Object.values(complete)).primary).toBe(43);
	});

	it('deduplicates satellites and signal cells while retaining the latest C/N0', () => {
		const assembly = new RtkObservations();
		assembly.process(observation('BeiDou', [1, 2], true));
		const last = observation('BeiDou', [2, 3], false);
		last.measurements[0].cnrDbHz = 35;
		const complete = assembly.process(last).BeiDou;
		expect(complete.satellites).toEqual([1, 2, 3]);
		expect(complete.cells).toBe(6);
		expect(complete.cnrDbHz).toEqual([42, 42, 35, 42, 42, 42]);
	});

	it('discards an unfinished epoch rather than joining it to newer observations', () => {
		const assembly = new RtkObservations();
		assembly.process(observation('GPS', [1], true, 1000));
		assembly.process(observation('BeiDou', [1, 2], true, 1000));
		assembly.process(observation('GPS', [3], true, 2000));
		const complete = assembly.process(observation('BeiDou', [4], false, 2000));
		expect(complete.GPS.satellites).toEqual([3]);
		expect(complete.BeiDou.satellites).toEqual([4]);
	});

	it('suppresses an interrupted sequence until its end, then resumes complete epochs', () => {
		const assembly = new RtkObservations();
		assembly.process(observation('BeiDou', [1, 2], true));
		assembly.discontinuity();
		expect(assembly.process(observation('BeiDou', [3], false))).toBeUndefined();
		assembly.process(observation('BeiDou', [1, 2], true, 2000));
		expect(assembly.process(observation('BeiDou', [3], false, 2000)).BeiDou.satellites).toEqual([1, 2, 3]);
	});

	it('expires an abandoned sequence after reception silence', () => {
		const assembly = new RtkObservations();
		assembly.process(observation('GPS', [1], true, 1000, 1000));
		const complete = assembly.process(observation('BeiDou', [2], false, 9000, 9000));
		expect(Object.keys(complete)).toEqual(['BeiDou']);
	});
});
