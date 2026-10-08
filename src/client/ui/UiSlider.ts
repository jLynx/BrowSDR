import { defineComponent, h } from 'vue';
import UiInput from './UiInput';

export default defineComponent({
	name: 'UiSlider', inheritAttrs: false,
	props: {
		modelValue: { type: Number, required: true }, min: [String, Number], max: [String, Number],
		step: { type: [String, Number], default: 1 }, disabled: Boolean,
		inputLabel: String, valueText: String, compact: Boolean,
	},
	emits: ['update:modelValue'],
	setup(props, { attrs, slots, emit }) {
		return () => h('div', { ...attrs, class: ['slider-group', { 'compact-slider': props.compact }, attrs.class] }, [
			h(UiInput, {
				type: 'range', modelValue: props.modelValue, modelModifiers: { number: true },
				min: props.min, max: props.max, step: props.step, disabled: props.disabled, 'aria-label': props.inputLabel,
				'onUpdate:modelValue': (value: string | number) => emit('update:modelValue', value),
			}),
			h('span', { class: 'val' }, slots.default?.() ?? props.valueText ?? String(props.modelValue)),
		]);
	},
});
