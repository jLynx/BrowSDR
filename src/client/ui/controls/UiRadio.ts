import { defineComponent, h, vModelRadio, withDirectives } from 'vue';

export default defineComponent({
	name: 'UiRadio',
	inheritAttrs: false,
	props: { modelValue: [String, Number], value: [String, Number], name: String, disabled: Boolean, label: String },
	emits: ['update:modelValue', 'change'],
	setup(props, { attrs, slots, emit }) {
		return () =>
			h('label', { ...attrs, class: ['mode-radio', attrs.class] }, [
				withDirectives(
					h('input', {
						type: 'radio',
						value: props.value,
						name: props.name,
						disabled: props.disabled,
						'aria-label':
							props.label ??
							(slots
								.default?.()
								.map((node) => (typeof node.children === 'string' ? node.children : ''))
								.join('')
								.trim() ||
								undefined),
						'onUpdate:modelValue': (value: unknown) => emit('update:modelValue', value),
						onChange: (event: Event) => emit('change', event),
					}),
					[[vModelRadio, props.modelValue]],
				),
				h('span', { class: 'mode-btn' }, slots.default?.() ?? props.label),
			]);
	},
});
