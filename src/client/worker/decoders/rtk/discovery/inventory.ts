import type { RtkStation } from '@/worker/decoders/rtk/types';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import type { RtkDiscoveryCatalog } from './catalog';

/** Merge independent acquisition lanes without joining partial protocol fragments. */
export function discoveryInventory(catalogs: RtkDiscoveryCatalog[]): RtkStation[] {
	const stations = new Map<string, RtkStation>();
	for (const catalog of catalogs)
		for (const station of catalog.snapshot()) {
			const key = `${station.discovery!.profile}:${stationKey(station)}`;
			const previous = stations.get(key);
			if (!previous) {
				stations.set(key, station);
				continue;
			}
			const [older, newer] = previous.lastSeen > station.lastSeen ? [station, previous] : [previous, station];
			const frequencies = [...older.discovery!.frequenciesMHz];
			for (const frequency of newer.discovery!.frequenciesMHz)
				if (!frequencies.some((value) => Math.abs(value - frequency) < 0.075)) frequencies.push(frequency);
			frequencies.sort((a, b) => a - b);
			const observations = { ...older.observations };
			for (const [name, value] of Object.entries(newer.observations ?? {}))
				if (!observations[name] || value.receivedAt >= observations[name].receivedAt) observations[name] = value;
			stations.set(key, {
				...newer,
				lastCorrection: Math.max(older.lastCorrection ?? 0, newer.lastCorrection ?? 0) || undefined,
				reference: newer.reference ?? older.reference,
				equipment: newer.equipment ?? older.equipment,
				observations,
				rtcmCount: Math.max(older.rtcmCount, newer.rtcmCount),
				rtcmTypes: Object.fromEntries(
					[...new Set([...Object.keys(older.rtcmTypes), ...Object.keys(newer.rtcmTypes)])].map((type) => [
						type,
						Math.max(older.rtcmTypes[type] ?? 0, newer.rtcmTypes[type] ?? 0),
					]),
				),
				discovery: {
					...newer.discovery!,
					frequencyMHz: frequencies[0],
					frequenciesMHz: frequencies,
					hoppingObserved: frequencies.length > 1,
					verifiedFrames: older.discovery!.verifiedFrames + newer.discovery!.verifiedFrames,
				},
			});
		}
	return [...stations.values()].slice(0, 64);
}
