import { defineComponent, h } from 'vue';

export default defineComponent({
	name: 'UiSnackbar', props: { show: Boolean, message: String },
	setup(props) { return () => h('div', { class: ['snackbar', { show: props.show }], role: 'status', 'aria-live': 'polite' }, props.message); },
});
