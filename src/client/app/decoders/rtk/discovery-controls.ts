import { computed, ref } from 'vue';
import type { ComputedRef } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkStationEntry } from './types';
import { fitDiscoveryRange } from './discovery/range';
import { errorMessage } from '@/platform/errors';
import { trackingVfo, discoverFollowers } from './discovery/followers';
import { hopPlanAvailability } from '@/worker/decoders/rtk/receiver/policy';

export function useDiscoveryControls(receiver: AppInstance, entry: ComputedRef<RtkStationEntry | undefined>) {
	const index = computed(() => receiver.activeVfoIndex);
	const vfo = computed(() => receiver.vfos[index.value]);
	const scanError = ref('');
	const scanApplying = ref(false);
	const applyRange = async (recenter: boolean) => {
		if (scanApplying.value) return;
		const scout = vfo.value;
		const start = scout.rtkScanStart ?? 915,
			end = scout.rtkScanEnd ?? 928;
		scanApplying.value = true;
		try {
			await fitDiscoveryRange(receiver, start, end, recenter);
			if (
				!receiver.vfos.includes(scout) ||
				scout.rtkProfile !== 'scan' ||
				(scout.rtkScanStart ?? 915) !== start ||
				(scout.rtkScanEnd ?? 928) !== end
			)
				return;
			scanError.value = '';
			scout.rtk = true;
			const scoutIndex = receiver.vfos.indexOf(scout);
			receiver.updateBackendVfoParams(scoutIndex);
			discoverFollowers(receiver, scout, receiver.rtk.sources[scoutIndex] ?? []);
		} catch (error) {
			scanError.value = errorMessage(error);
		} finally {
			scanApplying.value = false;
		}
	};
	return {
		scanning: computed(() => vfo.value?.rtkProfile === 'scan'),
		scanError,
		scanApplying,
		trackingCount: computed(() => receiver.vfos.filter((channel) => channel.rtk && channel.rtkFollowSource).length),
		trackingIndex: (source: string, profile: RtkStationEntry['profile']) => trackingVfo(receiver, source, profile),
		bandLimited: computed(
			() => hopPlanAvailability('rtk3', 915401000, receiver.radio.sampleRate, receiver.radio.centerFreq * 1e6) === 'band-limited',
		),
		updateAutoTracking: () => discoverFollowers(receiver, vfo.value, receiver.rtk.sources[index.value] ?? []),
		applyScan: () => applyRange(true),
		useReceivedBand: () => {
			vfo.value.rtkScanStart = Math.max(900, Math.ceil((receiver.radio.centerFreq - receiver.radio.sampleRate / 2e6 + 0.3) * 1000) / 1000);
			vfo.value.rtkScanEnd = Math.min(930, Math.floor((receiver.radio.centerFreq + receiver.radio.sampleRate / 2e6 - 0.3) * 1000) / 1000);
			return applyRange(false);
		},
		followDiscovered: async () => {
			if (!entry.value) return;
			const { frequency, source, profile } = entry.value;
			let target = trackingVfo(receiver, source, profile);
			if (target < 0) {
				await receiver.addRtkTrackingVfo(entry.value.station.discovery?.latestFrequencyMHz ?? frequency, source);
				target = trackingVfo(receiver, source, profile);
			}
			if (target >= 0) receiver.activeVfoIndex = target;
		},
	};
}
