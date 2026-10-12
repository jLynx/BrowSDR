import type { Vessel } from '@/worker/decoders/ais/types';

export function visibleVessels(sources: Vessel[][], now: number): Vessel[] {
	const merged = new Map<string, Vessel>();
	for (const vessel of sources.flat()) {
		if (now - vessel.lastSeen > 600000) continue;
		const old = merged.get(vessel.mmsi);
		const latest = !old || vessel.lastSeen >= old.lastSeen ? vessel : old;
		const earlier = latest === vessel ? old : vessel;
		const combined = { ...earlier, ...Object.fromEntries(Object.entries(latest).filter(([, value]) => value !== undefined)) } as Vessel;
		// Keep the latest dynamic report's position validity, including unavailable coordinates.
		const dynamic = !old || (vessel.positionTime ?? -1) >= (old.positionTime ?? -1) ? vessel : old;
		combined.latitude = dynamic.latitude;
		combined.longitude = dynamic.longitude;
		combined.positionTime = dynamic.positionTime;
		combined.speed = dynamic.speed;
		combined.course = dynamic.course;
		combined.heading = dynamic.heading;
		combined.navigationStatus = dynamic.navigationStatus;
		merged.set(vessel.mmsi, combined);
	}
	return [...merged.values()].sort((a, b) => a.mmsi.localeCompare(b.mmsi));
}

export function hasLiveVesselPosition(vessel: Vessel, now: number): boolean {
	return (
		vessel.latitude !== undefined &&
		vessel.longitude !== undefined &&
		vessel.positionTime !== undefined &&
		now - vessel.positionTime <= 180000
	);
}

const navigation = [
	'Under way using engine',
	'At anchor',
	'Not under command',
	'Restricted manoeuvrability',
	'Constrained by draught',
	'Moored',
	'Aground',
	'Fishing',
	'Under way sailing',
];
export function navigationText(status?: number): string {
	return status === undefined ? 'Unknown' : (navigation[status] ?? 'Other / unavailable');
}
