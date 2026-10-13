import { SONDE_POSITION_TTL, SONDE_TTL, SONDE_LIMIT, type Radiosonde } from '@/worker/decoders/radiosonde/types';

export function hasLiveSondePosition(item: Radiosonde, now: number): boolean {
	return (
		item.latitude !== undefined &&
		item.longitude !== undefined &&
		item.positionTime !== undefined &&
		now - item.positionTime <= SONDE_POSITION_TTL
	);
}

export function visibleSondes(sources: Radiosonde[][], now: number): Radiosonde[] {
	const merged = new Map<string, Radiosonde>();
	for (const source of sources)
		for (const sonde of source ?? []) {
			if (now - sonde.lastSeen <= SONDE_TTL && (!merged.has(sonde.id) || merged.get(sonde.id)!.lastSeen < sonde.lastSeen))
				merged.set(sonde.id, sonde);
		}
	return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, SONDE_LIMIT);
}
