import type { DisplayState } from '@/app/display/types';
import type { ContrastRange } from './contrast.types';

export function validContrastRange(minDB: number, maxDB: number): ContrastRange {
	const min = Number.isFinite(minDB) ? Math.max(-200, Math.min(-1, minDB)) : -118;
	const max = Number.isFinite(maxDB) ? Math.max(min + 1, Math.min(0, maxDB)) : Math.max(min + 1, -48);
	return { minDB: min, maxDB: max };
}

/** Estimate the floor from bounded, evenly spaced samples; ignore isolated strong peaks. */
export function autoContrastRange(data: Float32Array): ContrastRange | null {
	const values: number[] = [];
	const stride = Math.max(1, Math.floor(data.length / 1024));
	for (let i = 0; i < data.length; i += stride) {
		if (Number.isFinite(data[i]) && data[i] > -190) values.push(data[i]);
	}
	if (!values.length) return null;
	values.sort((a, b) => a - b);
	const floor = values[Math.floor(values.length * 0.3)];
	const strong = values[Math.floor(values.length * 0.98)];
	return validContrastRange(floor - 6, Math.max(floor + 45, strong + 5));
}

export function displayRange(display: DisplayState): ContrastRange {
	return validContrastRange(display.minDB, display.maxDB);
}
