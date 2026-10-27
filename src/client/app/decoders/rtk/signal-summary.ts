import type { RtcmObservation } from '@/worker/decoders/rtk/types';
import type { GnssSummary } from './types';

export function gnssSummary(observations: RtcmObservation[]): GnssSummary {
	const primary = new Set<string>(),
		secondary = new Set<string>(),
		bands = new Map<string, Set<number>>();
	let mapped = false;
	for (const observation of observations)
		for (const measurement of observation.measurements ?? []) {
			if (!measurement.band) continue;
			mapped = true;
			const key = `${observation.constellation}:${measurement.satellite}`;
			if (measurement.group === 'primary') primary.add(key);
			if (measurement.group === 'secondary') secondary.add(key);
			const band = `${observation.constellation} ${measurement.band}`;
			if (!bands.has(band)) bands.set(band, new Set());
			bands.get(band)!.add(measurement.satellite);
		}
	const strengths = observations.flatMap((observation) => observation.cnrDbHz).filter((value) => value > 0);
	const meanCnr = strengths.length ? strengths.reduce((total, value) => total + value, 0) / strengths.length : undefined;
	const quality = meanCnr === undefined ? 'Unavailable' : meanCnr >= 40 ? 'Good' : meanCnr >= 30 ? 'Fair' : 'Weak';
	return {
		primary: mapped ? primary.size : undefined,
		secondary: mapped ? secondary.size : undefined,
		bands: Object.fromEntries([...bands].map(([band, satellites]) => [band, satellites.size])),
		meanCnr,
		quality,
		tone: quality === 'Unavailable' ? 'idle' : (quality.toLowerCase() as GnssSummary['tone']),
	};
}
