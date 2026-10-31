import type { RtkStation } from '@/worker/decoders/rtk/types';
import type { Evidence } from './types';

function corrections(station: RtkStation, previous: RtkStation | undefined, tracked: Evidence['lastTracked']) {
	const rtcmTypes = { ...previous?.rtcmTypes };
	for (const [type, count] of Object.entries(station.rtcmTypes))
		rtcmTypes[type] = (rtcmTypes[type] ?? 0) + Math.max(0, count - (tracked?.rtcmTypes[type] ?? 0));
	return { rtcmCount: (previous?.rtcmCount ?? 0) + Math.max(0, station.rtcmCount - (tracked?.rtcmCount ?? 0)), rtcmTypes };
}

/** Preserve accumulated telemetry when the smaller protocol working set evicts a surveyed source. */
export function accumulateTelemetry(station: RtkStation, evidence: Evidence): RtkStation {
	const previous = evidence.station;
	const tracked = evidence.lastTracked && station.packets >= evidence.lastTracked.packets ? evidence.lastTracked : undefined;
	return {
		...station,
		...corrections(station, previous, tracked),
		name: station.equipment ? station.name : (previous?.name ?? station.name),
		reference: station.reference ?? previous?.reference,
		equipment: station.equipment ?? previous?.equipment,
		observations: { ...previous?.observations, ...station.observations },
		lastCorrection: Math.max(previous?.lastCorrection ?? 0, station.lastCorrection ?? 0) || undefined,
	};
}
