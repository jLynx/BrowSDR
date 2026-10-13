import { nextTick, onBeforeUnmount, watch, type Ref, type ComputedRef } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { Radiosonde } from '@/worker/decoders/radiosonde/types';
import type { SondeMap } from './map';
import { useMapFullscreen } from '@/app/decoders/adsb/fullscreen';

export function useSondeMap(
	receiver: AppInstance,
	showMap: Ref<boolean>,
	mapElement: Ref<HTMLElement | undefined>,
	positioned: ComputedRef<Radiosonde[]>,
	selected: Ref<string>,
	error: Ref<string>,
) {
	let map: SondeMap | undefined;
	let observer: ResizeObserver | undefined;
	let generation = 0;
	const { fullscreen, setFullscreen } = useMapFullscreen(
		() => receiver.radiosonde.panelOpen,
		() => (showMap.value = true),
		() => map?.resize(),
	);
	const select = (id: string) => {
		selected.value = id;
		map?.focus(id);
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
		() => receiver.radiosonde.panelOpen && showMap.value,
		async (open) => {
			destroy();
			if (!open) return;
			const current = generation;
			error.value = '';
			await nextTick();
			try {
				const [leaflet, { SondeMap }] = await Promise.all([import('leaflet'), import('./map')]);
				if (current !== generation || !mapElement.value) return;
				map = new SondeMap(
					leaflet,
					mapElement.value,
					() => {
						error.value = 'Map tiles unavailable. Sonde positions still update; check your internet connection.';
					},
					select,
				);
				if (typeof ResizeObserver !== 'undefined') {
					observer = new ResizeObserver(() => map?.resize());
					observer.observe(mapElement.value);
				}
				refresh();
			} catch {
				error.value = 'Could not load the map. Sonde data remains available in the list.';
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
