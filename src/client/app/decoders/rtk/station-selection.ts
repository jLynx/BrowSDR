import { computed, ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkStationEntry } from './types';
import type { Ref } from 'vue';
import { collectStations, selectedCorrections, receiverName, generationName, stationTitle, profileForVfo } from './stations';
import { loraNumber } from './station-details';
import { stationKey } from '@/worker/decoders/rtk/station-key';

export function useStationSelection(receiver: AppInstance, now: Ref<number>) {
	const selected = ref('');
	const entries = computed(() => collectStations(receiver, now.value));
	const hopSources = computed(() => {
		const vfo = receiver.vfos[receiver.activeVfoIndex];
		const profile = profileForVfo(receiver, receiver.activeVfoIndex);
		const sources = new Map<string, string>();
		receiver.vfos.forEach((channel, index) => {
			if (!profile || !channel.rtk || receiver.rtk.frequencies[index] !== channel.freq) return;
			// Verified beacons are enough to choose a base before its first complete correction.
			for (const station of receiver.rtk.sources[index] ?? [])
				if ((station.discovery?.profile ?? profileForVfo(receiver, index)) === profile)
					sources.set(stationKey(station), loraNumber(station));
		});
		if (vfo?.rtkFollowSource && !sources.has(vfo.rtkFollowSource)) sources.set(vfo.rtkFollowSource, 'Selected base');
		return [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([source, label]) => ({ source, label }));
	});
	const entry = computed(() => {
		const available = entries.value.filter((item) => item.indices.includes(receiver.activeVfoIndex));
		const vfo = receiver.vfos[receiver.activeVfoIndex];
		return (
			available.find((item) => item.key === selected.value) ??
			available.find((item) => (vfo?.rtkFollowHops || vfo?.rtkProfile === 'auto') && item.source === vfo.rtkFollowSource) ??
			available[0]
		);
	});
	const selectStation = (item: RtkStationEntry) => {
		selected.value = item.key;
		if (!item.indices.includes(receiver.activeVfoIndex)) receiver.activeVfoIndex = item.indices[0];
	};
	return {
		entries,
		hopSources,
		entry,
		selectStation,
		receiverName,
		generationName,
		stationTitle,
		station: computed(() => entry.value?.station),
		frames: computed(() => selectedCorrections(receiver, receiver.activeVfoIndex, entry.value)),
	};
}
