import { computed, defineComponent, inject, onBeforeUnmount, ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { hasLiveSondePosition, visibleSondes } from './sondes';
import { useSondeMap } from './map-view';
import { sondeDetails } from './details';
import template from './panel.html?raw';

export default defineComponent({
	name: 'RadiosondePanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('RadiosondePanel requires a receiver');
		const now = ref(Date.now());
		const selected = ref('');
		const query = ref('');
		const error = ref('');
		const showMap = ref(true);
		const mapElement = ref<HTMLElement>();
		const timer = setInterval(() => {
			now.value = Date.now();
		}, 1000);
		onBeforeUnmount(() => clearInterval(timer));
		const sondes = computed(() =>
			visibleSondes(
				receiver.radiosonde.sources.filter(
					(_, index) => receiver.vfos[index]?.radiosonde && receiver.vfos[index]?.freq >= 400 && receiver.vfos[index]?.freq <= 406,
				),
				now.value,
			),
		);
		const positioned = computed(() => sondes.value.filter((item) => hasLiveSondePosition(item, now.value)));
		const filtered = computed(() => sondes.value.filter((item) => item.id.toLowerCase().includes(query.value.toLowerCase())));
		const map = useSondeMap(receiver, showMap, mapElement, positioned, selected, error);
		const selectedSonde = computed(() => sondes.value.find((item) => item.id === selected.value));
		return {
			receiver,
			now,
			selected,
			query,
			error,
			showMap,
			mapElement,
			sondes,
			positioned,
			filtered,
			...map,
			active: computed(() => receiver.vfos.some((vfo) => vfo.radiosonde)),
			selectedVfo: computed(() => receiver.vfos[receiver.activeVfoIndex]),
			selectedSonde,
			details: computed(() => sondeDetails(selectedSonde.value, now.value)),
			blockType: (type: number) => `0x${type.toString(16).toUpperCase()}`,
			hasLiveSondePosition,
			format: (value: number | undefined, decimals = 1, unit = '') => (value === undefined ? '—' : `${value.toFixed(decimals)}${unit}`),
		};
	},
});
