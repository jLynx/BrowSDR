import { defineComponent, h, vModelDynamic, withDirectives, type PropType } from 'vue';

/** Native Vue model semantics, including number/trim/lazy and native input events. */
export default defineComponent({
	name: 'UiInput',
	inheritAttrs: false,
	props: {
		modelValue: { type: [String, Number] as PropType<string | number>, default: '' },
		modelModifiers: { type: Object, default: () => ({}) },
		type: { type: String, default: 'text' },
	},
	emits: ['update:modelValue'],
	setup(props, { attrs, emit }) {
		return () =>
			withDirectives(
				h('input', {
					...attrs,
					type: props.type,
					'onUpdate:modelValue': (value: string | number) => emit('update:modelValue', value),
				}),
				[[vModelDynamic, props.modelValue, undefined, props.modelModifiers]],
			);
	},
});
