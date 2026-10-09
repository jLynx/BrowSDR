import type { Aircraft, AircraftState } from './types';
import { updateAircraft, validAdsbFrame } from './messages';

export class AircraftTracker {
	private aircraft = new Map<string, AircraftState>();
	frames = 0;

	process(bytes: Uint8Array, time = Date.now()): void {
		if (!validAdsbFrame(bytes)) return;
		this.frames++;
		const icao = Array.from(bytes.subarray(1, 4), (byte) => byte.toString(16).padStart(2, '0'))
			.join('')
			.toUpperCase();
		let aircraft = this.aircraft.get(icao);
		if (!aircraft) {
			if (this.aircraft.size >= 500) this.aircraft.delete(this.aircraft.keys().next().value!);
			aircraft = { icao, lastSeen: time, messages: 0 };
			this.aircraft.set(icao, aircraft);
		}
		updateAircraft(bytes, aircraft, time);
	}

	snapshot(time = Date.now()): Aircraft[] {
		const result: Aircraft[] = [];
		for (const [icao, aircraft] of this.aircraft) {
			if (time - aircraft.lastSeen > 120000) {
				this.aircraft.delete(icao);
				continue;
			}
			const { even: _even, odd: _odd, ...record } = aircraft;
			if (time - (record.positionTime ?? 0) > 30000) {
				delete record.latitude;
				delete record.longitude;
				delete record.positionTime;
			}
			result.push(record);
		}
		return result;
	}
}
