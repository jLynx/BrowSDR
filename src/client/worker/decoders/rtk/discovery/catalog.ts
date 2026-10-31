import type { RtkProfile, RtkStation, RtkMessage } from '@/worker/decoders/rtk/types';
import type { VerifiedObservation } from '@/worker/decoders/rtk/receiver/types';
import { RtkTracker } from '@/worker/decoders/rtk/rtcm';
import { Rtk2Tracker } from '@/worker/decoders/rtk/rtk2/tracker';
import { Rtk3Tracker } from '@/worker/decoders/rtk/rtk3/tracker';
import { stationKey } from '@/worker/decoders/rtk/station-key';
import type { Evidence } from './types';
import { accumulateTelemetry } from './telemetry';

/** A bounded inventory of verified sources, independent of the current survey channel. */
export class RtkDiscoveryCatalog {
	packets = 0;
	private trackers = { rtk1: new RtkTracker(), rtk2: new Rtk2Tracker(), rtk3: new Rtk3Tracker() };
	private sources = new Map<string, Evidence>();
	private pending: RtkMessage['rtcm'] = [];
	observe(radio: VerifiedObservation): void {
		this.packets++;
		const key = `${radio.profile}:${radio.source}`;
		const evidence = this.sources.get(key) ?? { count: 0, confirmed: false, lastTime: radio.time, frequencies: [] };
		if (radio.time - evidence.lastTime > 20 && !evidence.confirmed) evidence.count = 0;
		evidence.count++;
		evidence.lastTime = radio.time;
		evidence.confirmed ||= radio.beacon || evidence.count >= 2;
		const frequency = Math.round(radio.frequencyHz / 1000) / 1000;
		// Residual carrier/sample-clock errors must not turn one channel into several.
		if (!evidence.frequencies.some((previous) => Math.abs(previous - frequency) < 0.075)) {
			evidence.frequencies.push(frequency);
			evidence.frequencies.sort((a, b) => a - b);
			if (evidence.frequencies.length > 64) evidence.frequencies.pop();
		}
		this.sources.delete(key);
		this.sources.set(key, evidence);
		if (this.sources.size > 64) this.sources.delete(this.sources.keys().next().value!);
		this.trackers[radio.profile].process(radio.packet);
		this.refresh(radio.profile);
	}
	private refresh(profile: RtkProfile): void {
		for (const station of this.trackers[profile].snapshot()) {
			const evidence = this.sources.get(`${profile}:${stationKey(station)}`);
			if (!evidence) continue;
			evidence.station = {
				...accumulateTelemetry(station, evidence),
				packets: evidence.count,
				discovery: {
					profile,
					frequencyMHz: evidence.frequencies[0],
					frequenciesMHz: [...evidence.frequencies],
					hoppingObserved: evidence.frequencies.length > 1,
					verifiedFrames: evidence.count,
				},
			};
			evidence.lastTracked = { packets: station.packets, rtcmCount: station.rtcmCount, rtcmTypes: station.rtcmTypes };
		}
		this.pending.push(...this.trackers[profile].flush());
		if (this.pending.length > 512) this.pending.splice(0, this.pending.length - 512);
	}
	discontinuity(profile?: RtkProfile): void {
		if (profile) this.trackers[profile].discontinuity();
		else for (const tracker of Object.values(this.trackers)) tracker.discontinuity();
		for (const [key, evidence] of this.sources) if (!evidence.confirmed && (!profile || key.startsWith(`${profile}:`))) evidence.count = 0;
	}
	snapshot(): RtkStation[] {
		return structuredClone([...this.sources.values()].filter((value) => value.confirmed && value.station).map((value) => value.station!));
	}
	flush(): RtkMessage['rtcm'] {
		const frames = this.pending;
		this.pending = [];
		return frames;
	}
}
