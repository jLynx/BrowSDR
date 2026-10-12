import { defineComponent, h } from 'vue';
import UiChevron from '@/ui/indicators/UiChevron';

export default defineComponent({
	name: 'UiPanelHeader',
	props: {
		collapsed: Boolean,
		collapsible: { type: Boolean, default: true },
		label: String,
		showChevron: { type: Boolean, default: true },
	},
	emits: ['toggle'],
	setup(props, { slots, emit }) {
		const toggle = () => {
			if (props.collapsible) emit('toggle');
		};
		return () =>
			h(
				'div',
				{
					class: ['panel-header', { 'panel-header-collapsible': props.collapsible }],
					role: props.collapsible ? 'button' : undefined,
					tabindex: props.collapsible ? 0 : undefined,
					'aria-expanded': props.collapsible ? !props.collapsed : undefined,
					onClick: toggle,
					onKeydown: (event: KeyboardEvent) => {
						if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
							event.preventDefault();
							toggle();
						}
					},
				},
				[
					slots.default?.() ?? h('span', props.label),
					props.collapsible && props.showChevron ? h(UiChevron, { collapsed: props.collapsed }) : null,
				],
			);
	},
});
