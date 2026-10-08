import { defineComponent, h, vModelSelect, withDirectives, type PropType } from 'vue';

export default defineComponent({
	name: 'UiSelect', inheritAttrs: false,
	props: {
		modelValue: { type: [String, Number, Array] as PropType<string | number | (string | number)[]>, default: '' },
		modelModifiers: { type: Object, default: () => ({}) },
	},
	emits: ['update:modelValue'],
	setup(props, { attrs, slots, emit }) {
		return () => withDirectives(h('select', {
			...attrs, 'onUpdate:modelValue': (value: unknown) => emit('update:modelValue', value),
		}, slots.default?.()), [[vModelSelect, props.modelValue, undefined, props.modelModifiers]]);
	},
});
