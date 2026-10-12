import { computed, defineComponent, inject, onBeforeUnmount, ref, watch } from 'vue';
import { useVesselMap } from './map-view';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { visibleVessels, hasLiveVesselPosition, navigationText } from './vessels';
import { loadMids, maritimeMid } from './database';
import template from './panel.html?raw';

export default defineComponent({
	name: 'AisPanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('AisPanel requires a receiver');
		const mapElement = ref<HTMLElement>();
		const now = ref(Date.now());
		const selected = ref('');
		const error = ref('');
		const query = ref('');
		const showMap = ref(true);
		const mids = ref<Record<string, string>>({});
		const databaseStatus = ref('Loading ITU country allocations...');
		watch(
			() => receiver.ais.panelOpen,
			async (open) => {
				if (!open || Object.keys(mids.value).length) return;
				const value = await loadMids();
				mids.value = value ?? {};
				databaseStatus.value = value ? 'ITU MID country allocations' : 'Country database unavailable';
			},
			{ immediate: true },
		);
		const vessels = computed(() =>
			visibleVessels(
				receiver.ais.sources.filter(
					(_, index) => receiver.vfos[index]?.ais && [161.975, 162.025].includes(receiver.vfos[index]?.freq ?? 0),
				),
				now.value,
			),
		);
		const positioned = computed(() => vessels.value.filter((item) => hasLiveVesselPosition(item, now.value)));
		const filtered = computed(() =>
			vessels.value.filter((item) =>
				`${item.mmsi} ${item.callsign ?? ''} ${item.name ?? ''}`.toLowerCase().includes(query.value.toLowerCase()),
			),
		);
		const timer = setInterval(() => {
			now.value = Date.now();
		}, 1000);
		onBeforeUnmount(() => clearInterval(timer));
		const { fullscreen, setFullscreen, select, fit } = useVesselMap(receiver, showMap, mapElement, positioned, selected, error);
		return {
			receiver,
			mapElement,
			now,
			selected,
			query,
			error,
			showMap,
			fullscreen,
			setFullscreen,
			selectedVfo: computed(() => receiver.vfos[receiver.activeVfoIndex]),
			vessels,
			positioned,
			filtered,
			active: computed(() => receiver.vfos.some((vfo) => vfo.ais)),
			selectedVessel: computed(() => vessels.value.find((item) => item.mmsi === selected.value)),
			select,
			databaseStatus,
			country: (mmsi: string) => mids.value[maritimeMid(mmsi) ?? ''] ?? 'Unknown',
			navigationText,
			fit,
			hasLiveVesselPosition,
		};
	},
});
