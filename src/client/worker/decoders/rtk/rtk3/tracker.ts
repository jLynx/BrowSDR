import type { LoraPacket, RtkMessage, RtkStation } from '@/worker/decoders/rtk/types';
import { RtkStations } from '@/worker/decoders/rtk/stations';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import { decodeRtk3Frame } from './frame';
import { Rtk3Containers } from './containers';
import type { BaseStream } from './types';

export class Rtk3Tracker {
	private bases = new Map<string, BaseStream>();
	private stations = new RtkStations();
	readonly counters = { packets: 0, crcErrors: 0, beacons: 0, containers: 0, containerErrors: 0, sequenceGaps: 0 };

	process(packet: LoraPacket): void {
		const frame = decodeRtk3Frame(packet);
		if (!frame) {
			this.counters.crcErrors++;
			// The damaged address is untrusted too; discard every incomplete base.
			this.discontinuity();
			return;
		}
		this.counters.packets++;
		const identity = {
			address: frame.address,
			netId: frame.address,
			...(frame.addressPrefix ? { addressPrefix: frame.addressPrefix } : {}),
		};
		const key = stationKey(identity);
		const base = this.base(key);
		const station = this.stations.observe(identity, packet);
		if (frame.beaconMs !== undefined) {
			this.counters.beacons++;
			// Handle device restart, including a possible uint32 uptime wrap.
			if (base.beaconMs !== undefined && frame.beaconMs < base.beaconMs) {
				base.containers.reset(true);
				this.stations.discontinuity(stationKey(station));
			}
			base.beaconMs = frame.beaconMs;
			return;
		}
		const before = { ...base.containers.counters };
		base.containers.process(
			frame.body,
			(container) => {
				if (container.type === 1) this.stations.record(container.payload, station);
			},
			() => this.stations.discontinuity(stationKey(station)),
		);
		for (const name of ['containers', 'containerErrors', 'sequenceGaps'] as const)
			this.counters[name] += base.containers.counters[name] - before[name];
	}

	private base(key: string): BaseStream {
		const now = Date.now();
		const base = this.bases.get(key) ?? { containers: new Rtk3Containers(), lastSeen: now };
		// A fixed VFO misses most of a hop lap. Never join tails from separate visits.
		if (now - base.lastSeen > 2000) {
			base.containers.reset();
			this.stations.discontinuity(key);
		}
		base.lastSeen = now;
		this.bases.delete(key);
		this.bases.set(key, base);
		if (this.bases.size > 16) this.bases.delete(this.bases.keys().next().value!);
		return base;
	}

	discontinuity(): void {
		for (const base of this.bases.values()) base.containers.reset();
		this.stations.discontinuity();
	}
	snapshot(): RtkStation[] {
		return this.stations.snapshot();
	}
	flush(): RtkMessage['rtcm'] {
		return this.stations.flush();
	}
}
