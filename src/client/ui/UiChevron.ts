import { defineComponent, h } from 'vue';

export default defineComponent({
	name: 'UiChevron', props: { collapsed: Boolean, size: { type: [Number, String], default: 14 } },
	setup(props) {
		return () => h('svg', {
			class: ['panel-chevron', { 'panel-chevron-collapsed': props.collapsed }],
			viewBox: '0 0 24 24', width: props.size, height: props.size, 'aria-hidden': 'true',
		}, [h('path', { fill: 'currentColor', d: 'M7 10l5 5 5-5z' })]);
	},
});
