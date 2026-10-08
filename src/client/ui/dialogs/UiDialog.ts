import { defineComponent, h, type PropType } from 'vue';

export const dialogVariants = {
	default: '',
	edit: 'bookmark-edit-dialog',
	import: 'bm-import-dialog',
	clients: 'remote-clients-dialog',
	about: 'about-dialog',
} as const;

/** Slots preserve native refs in the receiver (e.g. bookmark input focus). */
export default defineComponent({
	name: 'UiDialog',
	inheritAttrs: false,
	props: {
		open: Boolean,
		title: String,
		variant: { type: String as PropType<keyof typeof dialogVariants>, default: 'default' },
		bodyVariant: { type: String as PropType<'padded' | 'flush'>, default: 'padded' },
		dismissible: { type: Boolean, default: true },
		dialogClass: String,
		titleClass: String,
		bodyClass: String,
	},
	emits: ['close'],
	setup(props, { attrs, slots, emit }) {
		return () =>
			props.open
				? h(
						'div',
						{
							class: 'bookmark-overlay',
							onClick: (event: MouseEvent) => {
								if (props.dismissible && event.target === event.currentTarget) emit('close');
							},
						},
						[
							h(
								'div',
								{
									...attrs,
									class: ['bookmark-dialog', dialogVariants[props.variant], props.dialogClass, attrs.class],
									role: 'dialog',
									'aria-modal': 'true',
									'aria-label': props.title,
								},
								[
									h('div', { class: ['bookmark-dialog-title', props.titleClass] }, slots.title?.() ?? props.title),
									h(
										'div',
										{ class: ['bookmark-dialog-body', { 'bookmark-dialog-body-flush': props.bodyVariant === 'flush' }, props.bodyClass] },
										slots.default?.(),
									),
									slots.footer ? h('div', { class: 'bookmark-dialog-footer' }, slots.footer()) : null,
								],
							),
						],
					)
				: null;
	},
});
