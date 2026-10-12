import type { Aircraft } from '@/worker/decoders/adsb/types';
import data from './assets/markers.json';
import type { MarkerData, MarkerShape } from './types';
import { aircraftColor } from './colors';

const markers = data as unknown as MarkerData;

export function aircraftIconKind(record: Pick<Aircraft, 'category'>, databaseType = ''): 'plane' | 'helicopter' | 'balloon' | 'glider' {
	if (record.category === 7) return 'helicopter'; // TC4 category 7: rotorcraft.
	if (record.category === 10) return 'balloon'; // TC3 category 2: lighter than air.
	if (record.category === 9) return 'glider'; // TC3 category 1: glider / sailplane.
	if (record.category && record.category <= 6) return 'plane';
	if (databaseType === 'BALL' || databaseType === 'SHIP') return 'balloon';
	if (databaseType === 'GLID') return 'glider';
	if (/^[HG]/.test(databaseType) || databaseType === 'UHEL') return 'helicopter';
	return 'plane';
}

function shapeFor(record: Aircraft, databaseType: string): MarkerShape {
	if (record.category === 7) return markers.shapes.helicopter;
	if (record.category === 9) return markers.shapes.glider;
	if (record.category === 10) return markers.shapes.balloon;
	const category = record.category ? `${String.fromCharCode(65 + Math.floor(record.category / 8))}${record.category % 8}` : '';
	const icon =
		markers.TypeDesignatorIcons[databaseType] ??
		markers.TypeDescriptionIcons[databaseType] ??
		markers.TypeDescriptionIcons[databaseType[0]] ??
		markers.CategoryIcons[category];
	const fallback = aircraftIconKind(record, databaseType);
	return markers.shapes[icon?.[0] ?? (fallback === 'plane' ? 'unknown' : fallback)];
}

function svg(shape: MarkerShape): string {
	const width = 1.35 * (shape.strokeScale ?? 1);
	if (shape.svg)
		return shape.svg
			.replaceAll('fillColor', 'currentColor')
			.replaceAll('strokeColor', '#111')
			.replaceAll('strokeWidth', String(width))
			.replace('SIZE', 'width="28" height="32"');
	const paths = (value?: string | string[]) => (value ? (Array.isArray(value) ? value : [value]) : []);
	const outline = paths(shape.path)
		.map((path) => `<path paint-order="stroke" fill="currentColor" stroke="#111" stroke-width="${width * 2}" d="${path}"/>`)
		.join('');
	const accents = paths(shape.accent)
		.map((path) => `<path fill="none" stroke="#111" stroke-width="${0.6 * width * (shape.accentMult ?? 1)}" d="${path}"/>`)
		.join('');
	return `<svg viewBox="${shape.viewBox}" width="28" height="32" aria-hidden="true"><g${shape.transform ? ` transform="${shape.transform}"` : ''}>${outline}${accents}</g></svg>`;
}

export function aircraftIconElement(record: Aircraft, selected: boolean, databaseType = ''): HTMLElement {
	const kind = aircraftIconKind(record, databaseType);
	const element = document.createElement('span');
	element.className = `adsb-plane adsb-${kind}${selected ? ' selected' : ''}`;
	element.dataset.aircraftKind = kind;
	element.style.transform = `rotate(${kind === 'balloon' ? 0 : (record.heading ?? 0)}deg)`;
	element.style.color = aircraftColor(record.altitude, selected, Date.now() - (record.positionTime ?? Date.now()) > 15000);
	element.innerHTML = svg(shapeFor(record, databaseType));
	return element;
}
