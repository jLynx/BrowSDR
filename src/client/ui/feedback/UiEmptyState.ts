import { defineComponent, h, type PropType } from 'vue';

export default defineComponent({
	name: 'UiEmptyState',
	props: { variant: { type: String as PropType<'bookmark' | 'transcript' | 'pocsag' | 'activity' | 'remote-clients'>, default: 'pocsag' } },
	setup(props, { slots }) {
		return () => h('div', { class: `${props.variant}-empty` }, slots.default?.());
	},
});
