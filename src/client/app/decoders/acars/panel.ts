import { computed, defineComponent, inject, ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import { ACARS_CHANNELS, isAcarsFrequency } from '@/worker/decoders/acars';
import * as components from '@/ui';
import template from './panel.html?raw';

export default defineComponent({
	name: 'AcarsPanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('AcarsPanel requires a receiver');
		const query = ref('');
		const channel = ref(131.55);
		const selected = ref('');
		const messages = computed(() =>
			receiver.acars.sources
				.flatMap((source, index) => {
					const vfo = receiver.vfos[index];
					if (!vfo?.acars || !source || source.freq !== vfo.freq || !isAcarsFrequency(vfo.freq)) return [];
					return source.messages.map((message) => ({ ...message, key: `${index}:${message.id}`, vfoIndex: index, frequency: vfo.freq }));
				})
				.sort((a, b) => b.receivedAt - a.receivedAt || a.vfoIndex - b.vfoIndex || b.id - a.id)
				.slice(0, 200),
		);
		const filtered = computed(() =>
			messages.value.filter((item) =>
				`${item.registration} ${item.flight ?? ''} ${item.label} ${item.text}`.toLowerCase().includes(query.value.toLowerCase()),
			),
		);
		return {
			receiver,
			query,
			channel,
			selected,
			messages,
			filtered,
			channels: ACARS_CHANNELS,
			selectedVfo: computed(() => receiver.vfos[receiver.activeVfoIndex]),
			selectedMessage: computed(() => messages.value.find((item) => item.key === selected.value)),
			active: computed(() => receiver.vfos.some((vfo) => vfo.acars)),
			isAcarsFrequency,
			time: (timestamp: number) => new Date(timestamp).toLocaleTimeString(),
		};
	},
});
