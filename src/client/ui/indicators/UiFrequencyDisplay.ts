import { defineComponent, h } from 'vue';
import UiInput from '@/ui/controls/UiInput';

export default defineComponent({
	name: 'UiFrequencyDisplay',
	props: {
		modelValue: { type: String, required: true },
		index: { type: Number, required: true },
		color: { type: String, required: true },
		active: Boolean,
		receiving: Boolean,
		enabled: { type: Boolean, default: true },
		outOfBand: Boolean,
		bookmark: String,
	},
	emits: ['update:modelValue', 'select', 'apply', 'focus'],
	setup(props, { emit }) {
		return () =>
			h(
				'div',
				{
					class: [
						'vfo-display',
						{
							'vfo-active': props.active,
							'vfo-squelch-open': props.receiving,
							'vfo-audio-off': !props.enabled,
							'vfo-oob': props.outOfBand,
						},
					],
					style: {
						borderColor: props.active || props.receiving ? props.color : undefined,
						'--sq-color': props.receiving ? props.color : undefined,
					},
					title: `Click to tune VFO ${props.index + 1}`,
					onClick: () => emit('select'),
				},
				[
					h('span', { class: 'vfo-label', style: { background: props.color } }, props.index + 1),
					h(UiInput, {
						class: 'vfo-freq-input',
						modelValue: props.modelValue,
						'aria-label': `VFO ${props.index + 1} frequency in MHz`,
						'onUpdate:modelValue': (value: string | number) => emit('update:modelValue', value),
						onBlur: (event: FocusEvent) => emit('apply', event),
						onKeyup: (event: KeyboardEvent) => {
							if (event.key === 'Enter') emit('apply', event);
						},
						onFocus: (event: FocusEvent) => emit('focus', event),
					}),
					h('div', { class: 'vfo-unit' }, 'MHz'),
					props.receiving
						? h('span', { class: 'vfo-rx-badge', style: { background: props.color }, title: 'Squelch open – receiving' }, 'RX')
						: null,
					props.outOfBand ? h('span', { class: 'vfo-oob-badge', title: 'Outside bandwidth – no audio' }, 'OOB') : null,
					!props.enabled
						? h('span', { class: 'vfo-mute-badge', title: 'Audio disabled' }, [
								h('svg', { viewBox: '0 0 24 24', width: 12, height: 12 }, [
									h('path', {
										fill: 'currentColor',
										d: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
									}),
								]),
							])
						: null,
					props.bookmark ? h('span', { class: 'vfo-bookmark-label', title: props.bookmark }, props.bookmark) : null,
				],
			);
	},
});
