import type { LoraPacket, RtkIdentity, RtkStation, RtkMessage } from './types';
import { decodeRtcmFields } from './rtcm-fields';
import { stationKey } from './station-key';

/** Shared station telemetry for validated radio protocols. */
export class RtkStations {
	private stations = new Map<string, RtkStation>();
	private pending: RtkMessage['rtcm'] = [];

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
		if (this.stations.size > 16) this.stations.delete(this.stations.keys().next().value!);
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
			station.observations ??= {};
			station.observations[fields.observation.constellation] = fields.observation;
		}
		if (this.pending.length < 64) this.pending.push({ type, stationId, source: stationKey(station), data: frame.slice() });
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
