import { computed, defineComponent, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { visibleAircraft, hasLivePosition } from './aircraft';
import type { AircraftMap } from './map/leaflet';
import AdsbDetails from './details';
import AdsbCacheControl from './cache-control';
import type { AircraftMetadata } from './types';
import template from './panel.html?raw';
import { useMapFullscreen } from './fullscreen';

export default defineComponent({
	name: 'AdsbPanel',
	template,
	components: { ...components, AdsbDetails, AdsbCacheControl },
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('AdsbPanel requires a receiver');
		const mapElement = ref<HTMLElement>();
		const now = ref(Date.now());
		const selected = ref('');
		const error = ref('');
		const query = ref('');
		const showMap = ref(true);
		const aircraft = computed(() =>
			visibleAircraft(
				receiver.adsb.sources.filter((_, index) => receiver.vfos[index]?.adsb && receiver.vfos[index]?.freq === 1090),
				now.value,
			),
		);
		const positioned = computed(() => aircraft.value.filter((item) => hasLivePosition(item, now.value)));
		const filtered = computed(() =>
			aircraft.value.filter((item) => `${item.icao} ${item.callsign ?? ''}`.toLowerCase().includes(query.value.toLowerCase())),
		);
		const timer = setInterval(() => {
			now.value = Date.now();
		}, 1000);
		let map: AircraftMap | undefined;
		let observer: ResizeObserver | undefined;
		let generation = 0;
		const { fullscreen, setFullscreen } = useMapFullscreen(
			() => receiver.adsb.panelOpen,
			() => (showMap.value = true),
			() => map?.resize(),
		);
		const select = (icao: string) => {
			selected.value = icao;
			map?.focus(icao);
		};
		const refresh = () => map?.update(positioned.value, selected.value, select);
		const destroy = () => {
			generation++;
			observer?.disconnect();
			observer = undefined;
			map?.destroy();
			map = undefined;
		};
		watch(
			() => receiver.adsb.panelOpen && showMap.value,
			async (open) => {
				destroy();
				if (!open) return;
				const current = generation;
				error.value = '';
				await nextTick();
				try {
					const [leaflet, { AircraftMap }] = await Promise.all([import('leaflet'), import('./map/leaflet')]);
					if (current !== generation || !mapElement.value) return;
					map = new AircraftMap(
						leaflet,
						mapElement.value,
						() => {
							error.value = 'Map tiles unavailable. Aircraft positions still update; check your internet connection.';
						},
						select,
					);
					if (typeof ResizeObserver !== 'undefined') {
						observer = new ResizeObserver(() => map?.resize());
						observer.observe(mapElement.value);
					}
					refresh();
				} catch {
					error.value = 'Could not load the map. Aircraft data remains available in the list.';
				}
			},
			{ immediate: true },
		);
		watch([positioned, selected], refresh);
		onBeforeUnmount(() => {
			clearInterval(timer);
			destroy();
		});
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
			aircraft,
			positioned,
			filtered,
			active: computed(() => receiver.vfos.some((vfo) => vfo.adsb)),
			selectedAircraft: computed(() => aircraft.value.find((item) => item.icao === selected.value)),
			select,
			setAircraftType: (metadata: AircraftMetadata) => map?.setAircraftType(selected.value, metadata),
			fit: () => map?.fit(),
			hasLivePosition,
		};
	},
});
