import { nextTick, onBeforeUnmount, watch, type Ref, type ComputedRef } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { AprsStation } from '@/worker/decoders/aprs/types';
import type { AprsMap } from './map';
import { useMapFullscreen } from '@/app/decoders/adsb/fullscreen';

export function useAprsMap(
	receiver: AppInstance,
	showMap: Ref<boolean>,
	mapElement: Ref<HTMLElement | undefined>,
	positioned: ComputedRef<AprsStation[]>,
	selected: Ref<string>,
	error: Ref<string>,
) {
	let map: AprsMap | undefined;
	let observer: ResizeObserver | undefined;
	let generation = 0;
	const { fullscreen, setFullscreen } = useMapFullscreen(
		() => receiver.aprs.panelOpen,
		() => (showMap.value = true),
		() => map?.resize(),
	);
	const select = (key: string) => {
		selected.value = key;
		map?.focus(key);
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
		() => receiver.aprs.panelOpen && showMap.value,
		async (open) => {
			destroy();
			if (!open) return;
			const current = generation;
			error.value = '';
			await nextTick();
			try {
				const [leaflet, { AprsMap }] = await Promise.all([import('leaflet'), import('./map')]);
				if (current !== generation || !mapElement.value) return;
				map = new AprsMap(
					leaflet,
					mapElement.value,
					() => {
						error.value = 'Map tiles unavailable. Station positions still update; check your internet connection.';
					},
					select,
				);
				if (typeof ResizeObserver !== 'undefined') {
					observer = new ResizeObserver(() => map?.resize());
					observer.observe(mapElement.value);
				}
				refresh();
			} catch {
				error.value = 'Could not load the map. Station data remains available in the list.';
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
