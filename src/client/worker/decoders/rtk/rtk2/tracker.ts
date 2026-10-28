import type { LoraPacket, RtkMessage, RtkStation } from '@/worker/decoders/rtk/types';
import { RtkStations } from '@/worker/decoders/rtk/stations';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import { validRtcmFrame } from '@/worker/decoders/rtk/rtcm-frame';
import { decodeRtk2Frame } from './frame';
import type { BaseStream } from './types';

export class Rtk2Tracker {
	private bases = new Map<string, BaseStream>();
	private stations = new RtkStations();
	readonly counters = { packets: 0, crcErrors: 0, beacons: 0, containers: 0, containerErrors: 0, sequenceGaps: 0 };

	process(packet: LoraPacket): void {
		const frame = decodeRtk2Frame(packet);
		if (!frame) {
			this.counters.crcErrors++;
			this.discontinuity();
			return;
		}
		this.counters.packets++;
		const identity = { protocol: 'rtk2' as const, network: frame.network, address: frame.address, netId: frame.address };
		const key = stationKey(identity);
		const station = this.stations.observe(identity, packet);
		const now = Date.now();
		const base = this.bases.get(key) ?? { partial: new Uint8Array(0), lastSeen: now };
		if (now - base.lastSeen > 2000) base.partial = new Uint8Array(0);
		base.lastSeen = now;
		this.bases.delete(key);
		this.bases.set(key, base);
		if (this.bases.size > 16) this.bases.delete(this.bases.keys().next().value!);
		if (base.sequence !== undefined) {
			const delta = (frame.sequence - base.sequence + 65536) % 65536;
			if (!delta) return;
			if (delta !== 1) {
				base.partial = new Uint8Array(0);
				if (delta < 32768) this.counters.sequenceGaps += delta - 1;
			}
		}
		base.sequence = frame.sequence;
		this.counters.containers++;
		if (!frame.body.length) {
			this.counters.beacons++;
			return;
		}
		this.parse(frame.body, base, station);
	}

	private parse(body: Uint8Array, base: BaseStream, station: RtkStation): void {
		const data = new Uint8Array(base.partial.length + body.length);
		data.set(base.partial);
		data.set(body, base.partial.length);
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
			if (!validRtcmFrame(frame)) {
				this.counters.containerErrors++;
				offset++;
				continue;
			}
			this.stations.record(frame, station);
			offset += frame.length;
		}
		base.partial = data.slice(offset);
	}

	discontinuity(): void {
		for (const base of this.bases.values()) base.partial = new Uint8Array(0);
	}
	snapshot(): RtkStation[] {
		return this.stations.snapshot();
	}
	flush(): RtkMessage['rtcm'] {
		return this.stations.flush();
	}
}
