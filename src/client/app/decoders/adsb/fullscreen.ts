import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

export function useMapFullscreen(isOpen: () => boolean, showMap: () => void, resize: () => void) {
	const fullscreen = ref(false);
	let button: HTMLElement | undefined;
	const setFullscreen = (value: boolean) => {
		if (value) button = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		fullscreen.value = value;
		if (value) showMap();
		void nextTick(resize);
	};
	const keyboard = (event: KeyboardEvent) => {
		if (event.key === 'Escape' && fullscreen.value) {
			setFullscreen(false);
			button?.focus();
		}
	};
	document.addEventListener('keydown', keyboard);
	watch(isOpen, (open) => {
		if (!open) setFullscreen(false);
	});
	onBeforeUnmount(() => document.removeEventListener('keydown', keyboard));
	return { fullscreen, setFullscreen };
}
