import { defineComponent, h, nextTick, ref, Teleport } from 'vue';
import { UiButton, UiDialog } from '@/ui';

export default defineComponent({
	name: 'KeyboardShortcuts',
	setup() {
		const open = ref(false);
		const trigger = ref<InstanceType<typeof UiButton>>();
		const closeButton = ref<InstanceType<typeof UiButton>>();
		const close = () => {
			open.value = false;
			(trigger.value?.$el as HTMLElement | undefined)?.focus({ preventScroll: true });
		};
		const show = async () => {
			open.value = true;
			await nextTick();
			(closeButton.value?.$el as HTMLElement | undefined)?.focus({ preventScroll: true });
		};
		return () => [
			h(
				UiButton,
				{
					ref: trigger,
					variant: 'icon',
					class: 'sidebar-about-btn sidebar-shortcuts-btn',
					title: 'Keyboard shortcuts',
					'aria-label': 'Keyboard shortcuts',
					'aria-haspopup': 'dialog',
					onClick: () => {
						void show();
					},
				},
				() => [
					h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true' }, [
						h('rect', { x: 2, y: 5, width: 20, height: 14, rx: 2, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }),
						h('path', { d: 'M6 9h1m4 0h1m4 0h1M6 12h1m4 0h1m4 0h1M7 15h10', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }),
					]),
					h('span', 'Shortcuts'),
				],
			),
			h(
				Teleport,
				{ to: 'body' },
				h(
					UiDialog,
					{
						open: open.value,
						title: 'Keyboard shortcuts',
						dialogClass: 'keyboard-shortcuts-dialog',
						onClose: close,
						onKeydown: (event: KeyboardEvent) => {
							if (event.key === 'Escape') {
								event.preventDefault();
								event.stopPropagation();
								close();
							}
							if (event.key === 'Tab') {
								event.preventDefault();
								(closeButton.value?.$el as HTMLElement | undefined)?.focus();
							}
						},
					},
					{
						default: shortcutReference,
						footer: () => h(UiButton, { ref: closeButton, variant: 'primary', onClick: close }, () => 'Close'),
					},
				),
			),
		];
	},
});

function shortcutReference() {
	return [
		h('dl', { class: 'keyboard-shortcuts-list' }, [
			h('dt', [h('kbd', '←'), ' / ', h('kbd', '→')]),
			h('dd', 'Tune the selected VFO down / up by its Snap Interval.'),
			h('dt', [h('kbd', '↑'), ' / ', h('kbd', '↓')]),
			h('dd', 'Zoom in / out around the view centre.'),
			h('dt', h('kbd', '[')),
			h('dd', 'Previous frequency bookmark.'),
			h('dt', h('kbd', ']')),
			h('dd', 'Next frequency bookmark.'),
		]),
	];
}
