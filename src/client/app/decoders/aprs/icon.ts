import type { AprsStation } from '@/worker/decoders/aprs/types';
import { symbolInfo } from './symbols';

const arrow = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
	<circle cx="12" cy="12" r="10" fill="currentColor" stroke="#111" stroke-width="1.5"/>
	<path d="M12 4L17 16L12 13L7 16Z" fill="#111"/>
</svg>`;
const glyph = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
	<circle cx="12" cy="12" r="10" fill="currentColor" stroke="#111" stroke-width="1.5"/>
	<text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="700" font-family="monospace" fill="#111"></text>
</svg>`;

/** Category-colored marker: moving stations point along their course, others show their symbol code. */
export function stationIconElement(station: AprsStation, selected: boolean): HTMLElement {
	const element = document.createElement('span');
	const category = station.type === 'station' ? symbolInfo(station.symbol).category : 'object';
	element.className = `aprs-marker aprs-${category}${selected ? ' selected' : ''}`;
	if (station.course !== undefined && (station.speed ?? 0) > 1) {
		element.innerHTML = arrow;
		element.style.transform = `rotate(${station.course}deg)`;
	} else {
		element.innerHTML = glyph;
		// Symbol characters come from the radio; textContent keeps them out of the markup.
		element.querySelector('text')!.textContent = station.symbol?.[1] ?? '•';
	}
	return element;
}
