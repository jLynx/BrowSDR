import type { AppInstance } from '@/app/core/receiver.types';
import type { DiscoveryVfo, Followers } from './types';
import type { RtkStation, RtkProfile } from '@/worker/decoders/rtk/types';
import { stationKey } from '@/worker/decoders/rtk/station-key';

export const MAX_RTK_TRACKERS = 8;
const receivers = new WeakMap<AppInstance, Followers>();

export function trackingVfo(receiver: AppInstance, source: string, profile: RtkProfile): number {
	return receiver.vfos.findIndex((vfo) => vfo.rtkFollowSource === source && (vfo.rtkProfile === 'auto' || vfo.rtkProfile === profile));
}

/** Serialize allocations while the scout continues receiving; identities survive hop visits. */
export function discoverFollowers(receiver: AppInstance, vfo: DiscoveryVfo, stations: RtkStation[]): void {
	if (!receiver.running || receiver.remoteMode === 'client' || vfo.rtkProfile !== 'scan' || !vfo.rtk || vfo.rtkAutoTrack === false) return;
	let state = receivers.get(receiver);
	if (!state) {
		state = { queue: Promise.resolve(), scouts: new WeakMap() };
		receivers.set(receiver, state);
	}
	const key = JSON.stringify([vfo.rtkScanStart, vfo.rtkScanEnd, receiver.radio.centerFreq, receiver.radio.sampleRate]);
	let scout = state.scouts.get(vfo);
	if (!scout || scout.key !== key) {
		scout = { key, attempted: new Set() };
		state.scouts.set(vfo, scout);
	}
	for (const station of stations) {
		if (!station.discovery) continue;
		const source = stationKey(station),
			id = `${station.discovery.profile}:${source}`;
		if (scout.attempted.has(id)) continue;
		scout.attempted.add(id);
		const frequency = station.discovery.latestFrequencyMHz ?? station.discovery.frequencyMHz;
		const profile = station.discovery.profile;
		const expected = scout;
		state.queue = state.queue
			.then(async () => {
				if (
					!receiver.running ||
					receiver.remoteMode === 'client' ||
					!receiver.vfos.includes(vfo) ||
					!vfo.rtk ||
					vfo.rtkProfile !== 'scan' ||
					vfo.rtkAutoTrack === false ||
					expected.key !== JSON.stringify([vfo.rtkScanStart, vfo.rtkScanEnd, receiver.radio.centerFreq, receiver.radio.sampleRate])
				) {
					expected.attempted.delete(id);
					return;
				}
				if (state.scouts.get(vfo) !== expected || trackingVfo(receiver, source, profile) >= 0) return;
				if (receiver.vfos.filter((channel) => channel.rtk && channel.rtkFollowSource).length >= MAX_RTK_TRACKERS) {
					expected.attempted.delete(id);
					return;
				}
				await receiver.addRtkTrackingVfo(frequency, source);
			})
			.catch((error: unknown) => {
				receiver.showMsg('Unable to add RTK tracking VFO');
				console.error(error);
			});
	}
}
