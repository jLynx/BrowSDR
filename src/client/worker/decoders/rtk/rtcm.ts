import type { LoraPacket, RtkStation, RtkMessage } from './types';
import { crc24q } from './rtcm-frame';
import { RtkStations } from './stations';
import { stationKey } from './station-key';

export { crc24q } from './rtcm-frame';

/** Reassemble only verified Mammotion radio bodies; RTCM has its own CRC. */
export class RtkTracker {
	private partial = new Map<string, Uint8Array>();
	private stations = new RtkStations();
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
		const station = this.stations.observe({ scan, channel, netId }, packet);
		// Keep fragment eviction in the same order as station telemetry.
		const partial = this.partial.get(key) ?? new Uint8Array(0);
		this.partial.delete(key);
		if (this.partial.size >= 16) this.partial.delete(this.partial.keys().next().value!);
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
				this.stations.discontinuity(stationKey(station));
				offset++;
				continue;
			}
			this.stations.record(frame, station);
			offset += frame.length;
		}
		this.partial.set(stationKey(station), data.slice(offset));
	}
	discontinuity(): void {
		this.partial.clear();
		this.stations.discontinuity();
	}
	snapshot(): RtkStation[] {
		return this.stations.snapshot();
	}
	flush(): RtkMessage['rtcm'] {
		return this.stations.flush();
	}
}
