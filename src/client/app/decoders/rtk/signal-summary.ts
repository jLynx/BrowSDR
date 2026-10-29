import type { RtcmObservation } from '@/worker/decoders/rtk/types';
import type { GnssSummary } from './types';
import { computed, type Ref } from 'vue';
import type { RtkStation } from '@/worker/decoders/rtk/types';

export function useSatelliteObservations(station: Ref<RtkStation | undefined>, now: Ref<number>, receiving: () => boolean) {
	const observations = computed(() => Object.values(station.value?.observations ?? {}));
	const freshObservations = computed(() => (receiving() ? observations.value.filter((value) => now.value - value.receivedAt < 5000) : []));
	const lastObservation = computed(() =>
		observations.value.length ? Math.max(...observations.value.map((value) => value.receivedAt)) : undefined,
	);
	const displayedObservations = computed(() =>
		freshObservations.value.length
			? freshObservations.value
			: observations.value.filter((value) => value.receivedAt === lastObservation.value),
	);
	const satelliteCount = computed(() =>
		displayedObservations.value.length
			? displayedObservations.value.reduce((count, value) => count + value.satellites.length, 0)
			: undefined,
	);
	const satelliteFreshness = computed(() =>
		freshObservations.value.length ? 'Current observations' : 'Showing last received observations',
	);
	const gnss = computed(() => gnssSummary(displayedObservations.value));
	return { observations, freshObservations, lastObservation, displayedObservations, satelliteCount, satelliteFreshness, gnss };
}

export function gnssSummary(observations: RtcmObservation[]): GnssSummary {
	const primary = new Set<string>(),
		secondary = new Set<string>(),
		primarySignals = new Set<string>(),
		secondarySignals = new Set<string>(),
		bands = new Map<string, Set<number>>();
	let mapped = false;
	for (const observation of observations)
		for (const measurement of observation.measurements ?? []) {
			if (!measurement.band) continue;
			mapped = true;
			const key = `${observation.constellation}:${measurement.satellite}`;
			if (measurement.group === 'primary') {
				primary.add(key);
				primarySignals.add(`${key}:${measurement.signal}`);
			}
			if (measurement.group === 'secondary') {
				secondary.add(key);
				secondarySignals.add(`${key}:${measurement.signal}`);
			}
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
		primarySignals: mapped ? primarySignals.size : undefined,
		secondarySignals: mapped ? secondarySignals.size : undefined,
		bands: Object.fromEntries([...bands].map(([band, satellites]) => [band, satellites.size])),
		meanCnr,
		quality,
		tone: quality === 'Unavailable' ? 'idle' : (quality.toLowerCase() as GnssSummary['tone']),
	};
}
