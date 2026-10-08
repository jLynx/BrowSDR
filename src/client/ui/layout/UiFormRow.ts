import { defineComponent, h } from 'vue';

export default defineComponent({
	name: 'UiFormRow',
	props: { label: String, inputId: String },
	setup(props, { slots }) {
		return () => h('div', { class: 'form-row' }, [props.label ? h('label', { for: props.inputId }, props.label) : null, slots.default?.()]);
	},
});
