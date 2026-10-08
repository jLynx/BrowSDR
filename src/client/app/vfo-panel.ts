import { defineComponent } from 'vue';
import template from './vfo-panel.html?raw';
import * as components from '../ui';

/** Keep decoder telemetry in the affected panel's render effect. */
export default defineComponent({
	name: 'VfoPanel',
	template,
	components,
	inject: ['receiver'],
	props: { vfo: { type: Object, required: true }, i: { type: Number, required: true } },
});
