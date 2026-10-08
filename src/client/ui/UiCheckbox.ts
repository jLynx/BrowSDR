import { defineComponent, h, vModelCheckbox, withDirectives, type PropType } from 'vue';

export default defineComponent({
	name: 'UiCheckbox', inheritAttrs: false,
	props: {
		modelValue: { type: [Boolean, Number, String], default: false }, label: String, disabled: Boolean, title: String,
		inputId: String, inputLabel: String,
		variant: { type: String as PropType<'custom' | 'native'>, default: 'custom' },
		trueValue: { type: [Boolean, Number, String], default: true },
		falseValue: { type: [Boolean, Number, String], default: false },
	},
	emits: ['update:modelValue', 'change'],
	setup(props, { attrs, slots, emit }) {
		return () => h('label', { ...attrs, class: [props.variant === 'custom' ? 'custom-checkbox' : 'checkbox', attrs.class], title: props.title }, [
			withDirectives(h('input', {
				type: 'checkbox', disabled: props.disabled, id: props.inputId,
				'true-value': props.trueValue, 'false-value': props.falseValue,
				'aria-label': props.inputLabel,
				'onUpdate:modelValue': (value: boolean | number | string) => emit('update:modelValue', value),
				onChange: (event: Event) => emit('change', event),
			}), [[vModelCheckbox, props.modelValue]]),
			props.variant === 'custom' ? h('span', { class: 'checkmark' }) : ' ', slots.default?.() ?? props.label,
		]);
	},
});
