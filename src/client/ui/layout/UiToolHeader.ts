import { defineComponent, h, type PropType } from 'vue';

/** Shared decoder/tool header; content and actions remain in the receiver's scope. */
export default defineComponent({
	name: 'UiToolHeader',
	props: { variant: { type: String as PropType<'transcript' | 'pocsag' | 'activity'>, default: 'pocsag' } },
	setup(props, { slots }) {
		return () =>
			h('div', { class: `${props.variant}-header` }, [
				h('div', { class: `${props.variant}-title` }, slots.default?.()),
				h('div', { class: `${props.variant}-controls` }, slots.actions?.()),
			]);
	},
});
