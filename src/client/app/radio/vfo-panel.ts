import { defineComponent, inject, type PropType } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { Vfo } from '@/app/core/types';
import template from '@/app/templates/vfo-panel.html?raw';
import * as components from '@/ui';

/** Keep decoder telemetry in the affected panel's render effect. */
export default defineComponent({
	name: 'VfoPanel',
	template,
	components,
	props: { vfo: { type: Object as PropType<Vfo>, required: true }, i: { type: Number, required: true } },
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('VfoPanel requires a receiver');
		return { receiver };
	},
});
