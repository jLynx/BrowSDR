import type { LoraPacket, RtkStation, RtkMessage } from './types';
import { decodeRtcmFields } from './rtcm-fields';
import { stationKey } from './station-key';

export function crc24q(bytes: Uint8Array): number {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte << 16;
		for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x800000 ? 0x1864cfb : 0)) & 0xffffff;
	}
	return crc;
}

/** Reassemble only verified Mammotion radio bodies; RTCM has its own CRC. */
export class RtkTracker {
	private partial = new Map<string, Uint8Array>();
	private stations = new Map<string, RtkStation>();
	private pending: RtkMessage['rtcm'] = [];
	process(packet: LoraPacket): void {
		const data = packet.data;
		if (!packet.verified || data.length < 8 || data[0] !== 0x2c || data[7] !== data.length - 8) {
			this.discontinuity();
			return;
		}
		const scan = (data[5] << 8) | data[6],
			channel = data[1],
			netId = data[4];
		const key = stationKey({ scan, channel, netId });
		let station = this.stations.get(key);
		if (!station) {
			if (this.stations.size >= 16) {
				const oldest = this.stations.keys().next().value!;
				this.stations.delete(oldest);
				this.partial.delete(oldest);
			}
			station = {
				name: 'RTK base station',
				scan,
				channel,
				netId,
				packets: 0,
				lastSeen: 0,
				rtcmCount: 0,
				rtcmTypes: {},
				cfoHz: 0,
			};
			this.stations.set(key, station);
		}
		station.packets++;
		station.lastSeen = Date.now();
		station.cfoHz = packet.cfoHz;
		// Refresh eviction order and retain partial RTCM independently for interleaved bases.
		this.stations.delete(key);
		this.stations.set(key, station);
		const partial = this.partial.get(key) ?? new Uint8Array(0);
		const merged = new Uint8Array(partial.length + data.length - 8);
		merged.set(partial);
		for (let i = 8; i < data.length; i++) merged[partial.length + i - 8] = data[i] ^ 0x12;
		this.parse(merged, station);
	}
	private parse(data: Uint8Array, station: RtkStation): void {
		let offset = 0;
		while (offset + 3 <= data.length) {
			if (data[offset] !== 0xd3 || data[offset + 1] & 0xfc) {
				offset++;
				continue;
			}
			const length = ((data[offset + 1] & 3) << 8) | data[offset + 2];
			if (length < 3) {
				offset++;
				continue;
			}
			if (offset + length + 6 > data.length) break;
			const frame = data.subarray(offset, offset + length + 6);
			const checksum = (frame[length + 3] << 16) | (frame[length + 4] << 8) | frame[length + 5];
			if (crc24q(frame.subarray(0, length + 3)) !== checksum) {
				offset++;
				continue;
			}
			const type = (frame[3] << 4) | (frame[4] >> 4),
				stationId = ((frame[4] & 15) << 8) | frame[5];
			station.rtcmCount++;
			station.lastCorrection = Date.now();
			station.rtcmTypes[type] = (station.rtcmTypes[type] ?? 0) + 1;
			const fields = decodeRtcmFields(frame.subarray(3, length + 3));
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
			offset += frame.length;
		}
		this.partial.set(stationKey(station), data.slice(offset));
	}
	discontinuity(): void {
		this.partial.clear();
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
