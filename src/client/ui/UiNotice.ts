import { defineComponent, h } from 'vue';

/** Persistent feature guidance; capability decisions stay in the application. */
export default defineComponent({
	name: 'UiNotice',
	props: { title: String, message: String, href: String, linkLabel: String },
	setup(props, { slots }) {
		return () => h('div', { class: 'ui-notice', role: 'status' }, [
			props.title ? h('strong', props.title) : null,
			props.message ? h('p', props.message) : null,
			props.href ? h('a', { href: props.href, target: '_blank', rel: 'noopener noreferrer' }, props.linkLabel || 'Learn more') : null,
			slots.default?.(),
		]);
	},
});
