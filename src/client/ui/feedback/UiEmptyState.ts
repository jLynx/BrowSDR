import { defineComponent, h, type PropType } from 'vue';

export default defineComponent({
	name: 'UiEmptyState',
	props: {
		variant: { type: String as PropType<'bookmark' | 'transcript' | 'msgcenter' | 'activity' | 'remote-clients'>, default: 'msgcenter' },
	},
	setup(props, { slots }) {
		return () => h('div', { class: `${props.variant}-empty` }, slots.default?.());
	},
});
