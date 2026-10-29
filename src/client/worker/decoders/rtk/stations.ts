import type { LoraPacket, RtkIdentity, RtkStation, RtkMessage } from './types';
import { decodeRtcmFields } from './rtcm-fields';
import { stationKey } from './station-key';
import { RtkObservations } from './observations';

/** Shared station telemetry for validated radio protocols. */
export class RtkStations {
	private stations = new Map<string, RtkStation>();
	private pending: RtkMessage['rtcm'] = [];
	private observations = new Map<string, RtkObservations>();

	observe(identity: RtkIdentity, packet: LoraPacket): RtkStation {
		const key = stationKey(identity);
		const station = this.stations.get(key) ?? {
			...identity,
			name: 'RTK base station',
			packets: 0,
			lastSeen: 0,
			rtcmCount: 0,
			rtcmTypes: {},
			cfoHz: 0,
		};
		station.packets++;
		station.lastSeen = Date.now();
		station.cfoHz = packet.cfoHz;
		this.stations.delete(key);
		this.stations.set(key, station);
		if (this.stations.size > 16) {
			const oldest = this.stations.keys().next().value!;
			this.stations.delete(oldest);
			this.observations.delete(oldest);
		}
		return station;
	}

	/** Called only after the protocol parser validates the entire RTCM frame. */
	record(frame: Uint8Array, station: RtkStation): void {
		const type = (frame[3] << 4) | (frame[4] >> 4),
			stationId = ((frame[4] & 15) << 8) | frame[5];
		station.rtcmCount++;
		station.lastCorrection = Date.now();
		station.rtcmTypes[type] = (station.rtcmTypes[type] ?? 0) + 1;
		const fields = decodeRtcmFields(frame.subarray(3, frame.length - 3));
		if (fields.reference) station.reference = fields.reference;
		if (fields.equipment) {
			station.equipment = fields.equipment;
			station.name = fields.equipment.receiver.trim() || 'RTK base station';
		}
		if (fields.observation) {
			const key = stationKey(station);
			const assembly = this.observations.get(key) ?? new RtkObservations();
			this.observations.set(key, assembly);
			const complete = assembly.process(fields.observation);
			if (complete) station.observations = { ...station.observations, ...complete };
		}
		if (this.pending.length < 64) this.pending.push({ type, stationId, source: stationKey(station), data: frame.slice() });
	}

	discontinuity(key?: string): void {
		if (key) this.observations.get(key)?.discontinuity();
		else for (const assembly of this.observations.values()) assembly.discontinuity();
	}

	snapshot(): RtkStation[] {
		return structuredClone([...this.stations.values()]);
	}
	flush(): RtkMessage['rtcm'] {
		const result = this.pending;
		this.pending = [];
		return result;
	}
}
