import type { Vessel } from '@/worker/decoders/ais/types';

const boat = `<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
	<path d="M14 2C8 6 6 12 6 19L7 25H21L22 19C22 12 20 6 14 2Z"
		fill="currentColor" stroke="#111" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke"/>
	<path d="M14 6L10 11H18Z" fill="none" stroke="#111" stroke-width="1" stroke-linejoin="round"/>
	<rect x="10" y="14" width="8" height="7" rx="1" fill="none" stroke="#111" stroke-width="1"/>
	<path d="M10 17H18M10 23H18" fill="none" stroke="#111" stroke-width="1"/>
</svg>`;

export function vesselIconElement(vessel: Vessel, selected: boolean): HTMLElement {
	const element = document.createElement('span');
	element.className = `ais-vessel-marker${selected ? ' selected' : ''}`;
	element.style.transform = `rotate(${vessel.heading ?? vessel.course ?? 0}deg)`;
	element.innerHTML = boat;
	return element;
}
