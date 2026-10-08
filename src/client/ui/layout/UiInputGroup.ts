import { defineComponent, h } from 'vue';

export default defineComponent({
	name: 'UiInputGroup',
	props: { unit: String },
	setup(props, { slots }) {
		return () => h('div', { class: 'input-group' }, [slots.default?.(), props.unit ? h('span', props.unit) : null]);
	},
});
