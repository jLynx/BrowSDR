import { defineComponent, h } from 'vue';

export default defineComponent({
	name: 'UiLock',
	props: { locked: Boolean, host: Boolean },
	emits: ['toggle'],
	setup(props, { emit }) {
		const toggle = () => {
			if (props.host) emit('toggle');
		};
		return () =>
			h(
				'div',
				{
					class: ['lock-btn', { locked: props.locked, host: props.host }],
					title: props.host ? 'Toggle Lock' : 'Locked by Host',
					role: 'button',
					tabindex: props.host ? 0 : -1,
					'aria-pressed': props.locked,
					'aria-disabled': !props.host,
					onClick: toggle,
					onKeydown: (event: KeyboardEvent) => {
						if (['Enter', ' '].includes(event.key)) {
							event.preventDefault();
							toggle();
						}
					},
				},
				[
					h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' }, [
						h('path', {
							fill: 'currentColor',
							opacity: props.locked ? undefined : '0.3',
							d: props.locked
								? 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z'
								: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm5.1-9H7.9V6c0-2.26 1.84-4.1 4.1-4.1s4.1 1.84 4.1 4.1v2z',
						}),
					]),
				],
			);
	},
});
