import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkStationEntry } from './types';
import type { RtkProfile } from '@/worker/decoders/rtk/types';
import type { Vfo } from '@/app/core/types';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import { receptionState } from './reception';
import { observedSatellites } from './station-details';

export function receiverName(entry: RtkStationEntry['station']): string {
	const name = entry.equipment?.receiver.trim() || entry.name.trim();
	return name && name !== 'RTK base station' ? name : 'Receiver model not reported';
}

export function generationName(profile: RtkProfile): string {
	return `Mammotion ${profile.toUpperCase()}`;
}

export function profileForVfo(receiver: AppInstance, index: number): RtkProfile | undefined {
	const profile = receiver.vfos[index]?.rtkProfile ?? 'rtk1';
	return profile === 'scan' ? undefined : profile === 'auto' ? receiver.rtk.status[index]?.detectedProfile : profile;
}

export function stationTitle(entry: RtkStationEntry): string {
	return `${generationName(entry.profile)} · ${receiverName(entry.station)}`;
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
		discovery: newer.discovery ?? older.discovery,
	};
}

export function collectStations(receiver: AppInstance, now: number): RtkStationEntry[] {
	const entries = new Map<string, RtkStationEntry>();
	const discovered = new Set(
		receiver.rtk.sources
			.flatMap((sources) => sources ?? [])
			.filter((station) => station.discovery)
			.map((station) => `${station.discovery!.profile}:${stationKey(station)}`),
	);
	receiver.vfos.forEach((vfo, index) => {
		if (!vfo.rtk || receiver.rtk.frequencies[index] !== vfo.freq) return;
		for (const received of receiver.rtk.sources[index] ?? []) {
			const profile = received.discovery?.profile ?? profileForVfo(receiver, index);
			if (!profile) continue;
			let station = received;
			if (!station.rtcmCount && !station.discovery && !vfo.rtkFollowSource) continue;
			const frequency = station.discovery?.frequencyMHz ?? vfo.freq;
			const source = stationKey(station),
				key = entryKey(station, vfo, discovered, profile, source, frequency);
			const previous = entries.get(key);
			const indices = previous ? [...previous.indices, index] : [index];
			if (previous) station = mergeStation(previous.station, station);
			const fresh = receiver.running && Object.values(station.observations ?? {}).some((value) => now - value.receivedAt < 5000);
			entries.set(key, {
				key,
				source,
				frequency,
				profile,
				indices,
				station,
				satellites: fresh ? observedSatellites(station, now) : undefined,
				reception: receptionState({
					running: receiver.running,
					enabled: true,
					local: receiver.remoteMode !== 'client',
					inBand: receiver.isFreqInBandwidth(frequency),
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

function entryKey(
	station: RtkStationEntry['station'],
	vfo: Vfo,
	discovered: Set<string>,
	profile: RtkProfile,
	source: string,
	frequency: number,
): string {
	const identity = `${profile}:${source}`;
	return `${station.discovery || vfo.rtkFollowSource === source || discovered.has(identity) ? 'scan' : frequency}:${identity}`;
}

export function selectedCorrections(receiver: AppInstance, index: number, entry: RtkStationEntry | undefined) {
	if (!entry || !entry.indices.includes(index)) return [];
	const single = receiver.rtk.sources[index]?.length === 1;
	return (receiver.rtk.frames[index] ?? []).filter((frame) => frame.source === entry.source || (!frame.source && single));
}
