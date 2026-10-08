import { defineComponent, h } from 'vue';
import UiInput from './UiInput';

export default defineComponent({
	name: 'UiSpinbox',
	props: {
		modelValue: { type: [Number, String], required: true },
		step: { type: Number, default: 1 },
		min: Number,
		max: Number,
		disabled: Boolean,
		inputLabel: { type: String, default: 'Value' },
	},
	emits: ['update:modelValue'],
	setup(props, { emit }) {
		const adjust = (direction: number) => {
			if (props.disabled) return;
			const next = (Number(props.modelValue) || 0) + direction * props.step;
			emit('update:modelValue', Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, next)));
		};
		return () =>
			h('div', { class: 'spin-group' }, [
				h(UiInput, {
					type: 'number',
					modelValue: props.modelValue,
					modelModifiers: { number: true },
					step: props.step,
					min: props.min,
					max: props.max,
					disabled: props.disabled,
					'aria-label': props.inputLabel,
					'onUpdate:modelValue': (value: string | number) => emit('update:modelValue', value),
				}),
				h(
					'button',
					{ type: 'button', disabled: props.disabled, 'aria-label': `Decrease ${props.inputLabel}`, onClick: () => adjust(-1) },
					'-',
				),
				h(
					'button',
					{ type: 'button', disabled: props.disabled, 'aria-label': `Increase ${props.inputLabel}`, onClick: () => adjust(1) },
					'+',
				),
			]);
	},
});
