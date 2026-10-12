import { nextTick, onBeforeUnmount, watch, type Ref, type ComputedRef } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { Vessel } from '@/worker/decoders/ais/types';
import type { VesselMap } from './map';
import { useMapFullscreen } from '@/app/decoders/adsb/fullscreen';

export function useVesselMap(
	receiver: AppInstance,
	showMap: Ref<boolean>,
	mapElement: Ref<HTMLElement | undefined>,
	positioned: ComputedRef<Vessel[]>,
	selected: Ref<string>,
	error: Ref<string>,
) {
	let map: VesselMap | undefined;
	let observer: ResizeObserver | undefined;
	let generation = 0;
	const { fullscreen, setFullscreen } = useMapFullscreen(
		() => receiver.ais.panelOpen,
		() => (showMap.value = true),
		() => map?.resize(),
	);
	const select = (mmsi: string) => {
		selected.value = mmsi;
		map?.focus(mmsi);
	};
	const refresh = () => map?.update(positioned.value, selected.value);
	const destroy = () => {
		generation++;
		observer?.disconnect();
		observer = undefined;
		map?.destroy();
		map = undefined;
	};
	watch(
		() => receiver.ais.panelOpen && showMap.value,
		async (open) => {
			destroy();
			if (!open) return;
			const current = generation;
			error.value = '';
			await nextTick();
			try {
				const [leaflet, { VesselMap }] = await Promise.all([import('leaflet'), import('./map')]);
				if (current !== generation || !mapElement.value) return;
				map = new VesselMap(
					leaflet,
					mapElement.value,
					() => {
						error.value = 'Map tiles unavailable. Vessel positions still update; check your internet connection.';
					},
					select,
				);
				if (typeof ResizeObserver !== 'undefined') {
					observer = new ResizeObserver(() => map?.resize());
					observer.observe(mapElement.value);
				}
				refresh();
			} catch {
				error.value = 'Could not load the map. Vessel data remains available in the list.';
			}
		},
		{ immediate: true },
	);
	watch([positioned, selected], refresh);
	onBeforeUnmount(() => {
		destroy();
	});
	return { fullscreen, setFullscreen, select, fit: () => map?.fit() };
}
