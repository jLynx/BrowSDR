import { defineComponent, h, type PropType } from 'vue';

/** Existing button treatments. Extra classes/styles are forwarded to the native button. */
export const buttonVariants = {
	default: 'btn', primary: 'btn btn-primary', secondary: 'btn btn-secondary',
	stop: 'btn btn-stop', transcript: 'btn transcript-btn', kick: 'btn btn-kick',
	icon: 'icon-btn', copy: 'btn-copy',
	bookmark: 'bookmark-btn', jump: 'bookmark-btn bookmark-jump',
	edit: 'bookmark-btn bookmark-edit', delete: 'bookmark-btn bookmark-delete',
	'frequency-save': 'btn bookmark-save-btn bm-type-freq',
	'group-save': 'btn bookmark-save-btn bm-type-group', io: 'btn bm-io-btn',
	'import-merge': 'btn bm-import-choice', 'import-replace': 'btn bm-import-choice bm-import-replace',
	'auto-squelch': 'btn-auto-squelch', 'vfo-remove': 'vfo-remove-btn',
	'vfo-mute': 'vfo-mute-btn', solo: 'audio-solo-btn', 'search-clear': 'bm-search-clear',
	'receiver-tab': 'receiver-tab', device: 'device-picker-item device-picker-mock',
} as const;

export default defineComponent({
	name: 'UiButton', inheritAttrs: false,
	props: {
		variant: { type: String as PropType<keyof typeof buttonVariants>, default: 'default' },
		type: { type: String as PropType<'button' | 'submit' | 'reset'>, default: 'button' },
		disabled: Boolean, title: String,
	},
	emits: ['click'],
	setup(props, { attrs, slots, emit }) {
		return () => h('button', { ...attrs, type: props.type, disabled: props.disabled, title: props.title, class: [buttonVariants[props.variant], attrs.class], onClick: (event: MouseEvent) => { if (!props.disabled) emit('click', event); } }, slots.default?.());
	},
});
