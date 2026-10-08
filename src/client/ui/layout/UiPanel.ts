import { defineComponent, h, vShow, withDirectives } from 'vue';
import UiPanelHeader from './UiPanelHeader';

export default defineComponent({
	name: 'UiPanel',
	props: {
		label: String,
		collapsed: Boolean,
		disabled: Boolean,
		outOfBand: Boolean,
		condensed: Boolean,
		collapsible: { type: Boolean, default: true },
	},
	emits: ['update:collapsed'],
	setup(props, { slots, emit }) {
		return () =>
			h('div', { class: ['panel', { disabled: props.disabled, 'panel-oob': props.outOfBand }] }, [
				h(
					UiPanelHeader,
					{
						label: props.label,
						collapsed: props.collapsed,
						collapsible: props.collapsible,
						onToggle: () => emit('update:collapsed', !props.collapsed),
					},
					slots.header ? { default: slots.header } : undefined,
				),
				withDirectives(h('div', { class: ['panel-body', { 'panel-condensed': props.condensed }] }, slots.default?.()), [
					[vShow, !props.collapsed],
				]),
			]);
	},
});
