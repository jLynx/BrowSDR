import { computed, nextTick, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { RtcmReference } from '@/worker/decoders/rtk/types';
import type { BaseMap } from './map';
import { validBasePosition } from './station-details';

export function useBaseMap(
	isOpen: () => boolean,
	element: Ref<HTMLElement | undefined>,
	position: ComputedRef<RtcmReference | undefined>,
	identity: ComputedRef<string>,
	title: ComputedRef<string>,
) {
	let map: BaseMap | undefined,
		observer: ResizeObserver | undefined,
		generation = 0;
	const error = ref('');
	const visible = computed(() => isOpen() && validBasePosition(position.value));
	const refresh = () => {
		if (validBasePosition(position.value)) map?.update(position.value, identity.value, title.value);
	};
	const destroy = () => {
		generation++;
		observer?.disconnect();
		observer = undefined;
		map?.destroy();
		map = undefined;
	};
	watch(
		visible,
		async (open) => {
			destroy();
			if (!open) return;
			const current = generation;
			error.value = '';
			await nextTick();
			try {
				const [leaflet, { BaseMap }] = await Promise.all([import('leaflet'), import('./map')]);
				if (current !== generation || !element.value) return;
				map = new BaseMap(leaflet, element.value, () => {
					error.value = 'Map tiles unavailable. The decoded coordinates remain available.';
				});
				if (typeof ResizeObserver !== 'undefined') {
					observer = new ResizeObserver(() => map?.resize());
					observer.observe(element.value);
				}
				refresh();
			} catch {
				error.value = 'Could not load the map. The decoded coordinates remain available.';
			}
		},
		{ immediate: true },
	);
	watch([position, identity, title], refresh);
	onBeforeUnmount(destroy);
	return { mapVisible: visible, mapError: error };
}
