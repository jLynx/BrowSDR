import { defineComponent, type PropType } from 'vue';
import type { Vfo } from '@/app/core/types';
import type { HdStatus } from '@/worker/decoders/hd-radio/types';
import { UiFormRow, UiSelect } from '@/ui';
import template from './panel.html?raw';

export default defineComponent({
	name: 'HdRadioPanel',
	components: { UiFormRow, UiSelect },
	template,
	props: {
		vfo: { type: Object as PropType<Vfo>, required: true },
		status: { type: Object as PropType<HdStatus | null>, default: null },
	},
	emits: ['program'],
	computed: {
		selected() {
			return this.status?.programs.find((program) => program.program === (this.vfo.hdProgram ?? 0));
		},
	},
});
