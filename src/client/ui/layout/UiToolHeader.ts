import { defineComponent, h, type PropType } from 'vue';
import UiButton from '@/ui/controls/UiButton';

/** Shared decoder/tool header; content and actions remain in the receiver's scope. */
export default defineComponent({
	name: 'UiToolHeader',
	props: {
		variant: { type: String as PropType<'transcript' | 'pocsag' | 'activity'>, default: 'pocsag' },
		closable: Boolean,
		closeLabel: { type: String, default: 'Close tool' },
	},
	emits: ['close'],
	setup(props, { slots, emit }) {
		return () =>
			h('div', { class: [`${props.variant}-header`, { 'tool-header-closable': props.closable }] }, [
				h('div', { class: `${props.variant}-title` }, slots.default?.()),
				h('div', { class: 'tool-header-actions' }, [
					h('div', { class: `${props.variant}-controls` }, slots.actions?.()),
					props.closable
						? h(
								UiButton,
								{
									variant: 'transcript',
									class: 'tool-header-close',
									'aria-label': props.closeLabel,
									title: props.closeLabel,
									onClick: () => emit('close'),
								},
								() => '×',
							)
						: null,
				]),
			]);
	},
});
