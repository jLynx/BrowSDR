import type { WaterfallLevel } from './types';

export const WATERFALL_DB_MIN = -192;
export const WATERFALL_DB_SPAN = 256;

/** Full FFT followed by peak-preserving levels, each four times smaller. */
export function createWaterfallLayout(bins: number, maxTextureSize: number, requestedHistory: number) {
	const levels: WaterfallLevel[] = [];
	let count = bins;
	let offset = 0;
	let scale = 1;
	while (true) {
		levels.push({ offset, bins: count, scale });
		offset += count;
		if (count === 1) break;
		count = Math.ceil(count / 4);
		scale *= 4;
	}
	const width = Math.min(bins, maxTextureSize);
	const tiles = Math.ceil(offset / width);
	// Bound storage to 104 MiB, and reserve one slot for the fractional preview.
	const slots = Math.min(Math.floor(maxTextureSize / tiles), Math.floor((104 * 1024 * 1024) / (width * tiles * 2)));
	if (slots < 2) throw new Error('FFT history exceeds the GPU texture limits');
	const history = Math.min(requestedHistory, slots - 1);
	return { levels, width, tiles, history, height: (history + 1) * tiles };
}

export function encodeWaterfallLine(
	input: Float32Array | number[],
	levels: ReturnType<typeof createWaterfallLayout>['levels'],
	values: Float32Array,
	bytes: Uint8Array,
) {
	values.set(input);
	for (let level = 1; level < levels.length; level++) {
		const previous = levels[level - 1];
		const current = levels[level];
		for (let bin = 0; bin < current.bins; bin++) {
			let peak = -Infinity;
			for (let child = bin * 4; child < Math.min(bin * 4 + 4, previous.bins); child++) {
				peak = Math.max(peak, values[previous.offset + child]);
			}
			values[current.offset + bin] = peak;
		}
	}
	for (let i = 0; i < values.length; i++) {
		const value = Number.isFinite(values[i]) ? values[i] : WATERFALL_DB_MIN;
		const encoded = Math.round(Math.max(0, Math.min(1, (value - WATERFALL_DB_MIN) / WATERFALL_DB_SPAN)) * 65535);
		bytes[i * 2] = encoded >> 8;
		bytes[i * 2 + 1] = encoded & 255;
	}
}
