const balloon = `<svg viewBox="0 0 30 36" width="30" height="36" aria-hidden="true">
	<path d="M15 2C7 2 3 8 3 14C3 21 10 26 13 28H17C20 26 27 21 27 14C27 8 23 2 15 2Z" fill="currentColor" stroke="#111" stroke-width="1.5"/>
	<path d="M13 28L12 32H18L17 28M15 32V35" fill="none" stroke="#111" stroke-width="1.5"/>
	<path d="M15 5C11 5 8 9 8 14" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export function sondeIconElement(selected: boolean): HTMLElement {
	const element = document.createElement('span');
	element.className = `radiosonde-marker${selected ? ' selected' : ''}`;
	element.innerHTML = balloon;
	return element;
}
