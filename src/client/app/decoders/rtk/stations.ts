import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkStationEntry } from './types';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import { receptionState } from './reception';
import { observedSatellites } from './station-details';

export function receiverName(entry: RtkStationEntry['station']): string {
	return entry.equipment?.receiver.trim() || entry.name || 'RTK base station';
}

function mergeStation(a: RtkStationEntry['station'], b: RtkStationEntry['station']) {
	const [older, newer] = (a.lastCorrection ?? 0) > (b.lastCorrection ?? 0) ? [b, a] : [a, b];
	const observations = { ...older.observations };
	for (const [name, observation] of Object.entries(newer.observations ?? {}))
		if (!observations[name] || observation.receivedAt >= observations[name].receivedAt) observations[name] = observation;
	return {
		...newer,
		lastSeen: Math.max(a.lastSeen, b.lastSeen),
		reference: newer.reference ?? older.reference,
		equipment: newer.equipment ?? older.equipment,
		observations,
	};
}

export function collectStations(receiver: AppInstance, now: number): RtkStationEntry[] {
	const entries = new Map<string, RtkStationEntry>();
	receiver.vfos.forEach((vfo, index) => {
		if (!vfo.rtk || receiver.rtk.frequencies[index] !== vfo.freq) return;
		for (const received of receiver.rtk.sources[index] ?? []) {
			let station = received;
			if (!station.rtcmCount) continue;
			const source = stationKey(station),
				key = `${vfo.freq}:${vfo.rtkProfile ?? 'luba1'}:${source}`;
			const previous = entries.get(key);
			const indices = previous ? [...previous.indices, index] : [index];
			if (previous) station = mergeStation(previous.station, station);
			const fresh = receiver.running && Object.values(station.observations ?? {}).some((value) => now - value.receivedAt < 5000);
			entries.set(key, {
				key,
				source,
				frequency: vfo.freq,
				indices,
				station,
				satellites: fresh ? observedSatellites(station, now) : undefined,
				reception: receptionState({
					running: receiver.running,
					enabled: true,
					local: receiver.remoteMode !== 'client',
					inBand: receiver.isFreqInBandwidth(vfo.freq),
					status: receiver.rtk.status[index] ?? undefined,
					station,
					now,
				}),
			});
		}
	});
	// Stable identity order prevents selection targets moving with every packet.
	return [...entries.values()].sort((a, b) => a.frequency - b.frequency || a.source.localeCompare(b.source));
}

export function selectedCorrections(receiver: AppInstance, index: number, entry: RtkStationEntry | undefined) {
	if (!entry || !entry.indices.includes(index)) return [];
	const single = receiver.rtk.sources[index]?.length === 1;
	return (receiver.rtk.frames[index] ?? []).filter((frame) => frame.source === entry.source || (!frame.source && single));
}
