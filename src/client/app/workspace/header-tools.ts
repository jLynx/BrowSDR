import type { AppInstance } from '../core/types';

/** Collapse optional tools before they take the room needed by three VFOs. */
export function mountHeaderTools(app: AppInstance): () => void {
	const bar: HTMLElement = app.$refs.topBar;
	const vfos: HTMLElement = app.$refs.headerVfos;
	const controls: HTMLElement = app.$refs.headerControls;
	const tools: HTMLElement = app.$refs.headerTools;
	const list = tools.querySelector<HTMLElement>('.header-tool-list')!;
	const mobile = window.matchMedia('(max-width: 768px)');
	let frame = 0;
	const measure = () => {
		frame = 0;
		const cards = Array.from(vfos.children).slice(0, 3) as HTMLElement[];
		if (!cards.length) return;
		const gap = parseFloat(getComputedStyle(vfos).columnGap) || 0;
		const needed = cards.reduce((sum, card) => sum + card.getBoundingClientRect().width, 0) + gap * (cards.length - 1);
		const buttons = Array.from(list.children) as HTMLElement[];
		const toolGap = parseFloat(getComputedStyle(list).columnGap) || 0;
		// In compact mode each menu row has the same icon dimensions as the
		// persistent controls, so labels and the open menu cannot affect sizing.
		const iconWidth = controls.children[0].getBoundingClientRect().width;
		const expandedWidth = app.toolsCompact
			? buttons.length * iconWidth + toolGap * (buttons.length - 1)
			: list.getBoundingClientRect().width;
		const right = bar.getBoundingClientRect().right - (parseFloat(getComputedStyle(bar).paddingRight) || 0);
		const expandedControls = controls.getBoundingClientRect().width - tools.getBoundingClientRect().width + expandedWidth;
		const available = right - vfos.getBoundingClientRect().left - expandedControls - (parseFloat(getComputedStyle(bar).columnGap) || 0);
		const compact = mobile.matches || available < needed;
		if (app.toolsCompact !== compact) {
			app.toolsCompact = compact;
			app.toolsMenuOpen = false;
		}
	};
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(measure);
	};
	const observer = new ResizeObserver(schedule);
	observer.observe(bar);
	observer.observe(controls);
	let observedCards: Element[] = [];
	const observeCards = () => {
		observedCards.forEach((card) => observer.unobserve(card));
		observedCards = Array.from(vfos.children).slice(0, 3);
		observedCards.forEach((card) => observer.observe(card));
		schedule();
	};
	const mutations = new MutationObserver(observeCards);
	mutations.observe(vfos, { childList: true });
	observeCards();
	const outside = (event: PointerEvent) => {
		if (!tools.contains(event.target as Node)) app.toolsMenuOpen = false;
	};
	const keyboard = (event: KeyboardEvent) => {
		if (event.key === 'Escape' && app.toolsMenuOpen) {
			app.toolsMenuOpen = false;
			tools.querySelector<HTMLElement>('summary')?.focus();
		}
	};
	const focus = (event: FocusEvent) => {
		if (!tools.contains(event.relatedTarget as Node)) app.toolsMenuOpen = false;
	};
	document.addEventListener('pointerdown', outside);
	document.addEventListener('keydown', keyboard);
	tools.addEventListener('focusout', focus);
	mobile.addEventListener('change', schedule);
	return () => {
		observer.disconnect();
		mutations.disconnect();
		cancelAnimationFrame(frame);
		document.removeEventListener('pointerdown', outside);
		document.removeEventListener('keydown', keyboard);
		tools.removeEventListener('focusout', focus);
		mobile.removeEventListener('change', schedule);
	};
}
