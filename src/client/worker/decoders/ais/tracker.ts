import { decodeAis } from './messages';
import type { Vessel } from './types';

export class VesselTracker {
	frames = 0;
	private vessels = new Map<string, Vessel>();
	process(frame: Uint8Array, now = Date.now()): void {
		this.frames++;
		const report = decodeAis(frame);
		if (!report) return;
		const previous = this.vessels.get(report.mmsi);
		const vessel: Vessel = { ...previous, ...report, lastSeen: now, messages: (previous?.messages ?? 0) + 1 };
		if ('latitude' in report) vessel.positionTime = now;
		this.vessels.delete(report.mmsi);
		this.vessels.set(report.mmsi, vessel);
		if (this.vessels.size > 500) this.vessels.delete(this.vessels.keys().next().value!);
	}
	snapshot(now = Date.now()): Vessel[] {
		for (const [mmsi, vessel] of this.vessels) if (now - vessel.lastSeen > 600000) this.vessels.delete(mmsi);
		return [...this.vessels.values()].sort((a, b) => a.mmsi.localeCompare(b.mmsi)).map((vessel) => ({ ...vessel }));
	}
}
