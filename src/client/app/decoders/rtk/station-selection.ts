import { computed, ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { RtkStationEntry } from './types';
import type { Ref } from 'vue';
import { collectStations, selectedCorrections, receiverName, generationName, stationTitle } from './stations';

export function useStationSelection(receiver: AppInstance, now: Ref<number>) {
	const selected = ref('');
	const entries = computed(() => collectStations(receiver, now.value));
	const entry = computed(() => {
		const available = entries.value.filter((item) => item.indices.includes(receiver.activeVfoIndex));
		return available.find((item) => item.key === selected.value) ?? available[0];
	});
	const selectStation = (item: RtkStationEntry) => {
		selected.value = item.key;
		if (!item.indices.includes(receiver.activeVfoIndex)) receiver.activeVfoIndex = item.indices[0];
	};
	return {
		entries,
		entry,
		selectStation,
		receiverName,
		generationName,
		stationTitle,
		station: computed(() => entry.value?.station),
		frames: computed(() => selectedCorrections(receiver, receiver.activeVfoIndex, entry.value)),
	};
}
