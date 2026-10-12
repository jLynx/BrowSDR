import type { DetectedSignal, DiscoveryConfig } from './types';

/** Median noise power avoids measuring peaks against unusually deep noise troughs. */
function noiseFloor(data: Float32Array, blockSize: number): Float32Array {
	const floors = new Float32Array(Math.ceil(data.length / blockSize));
	for (let block = 0; block < floors.length; block++) {
		const values: number[] = [];
		const end = Math.min(data.length, (block + 1) * blockSize);
		const stride = Math.max(1, Math.floor(blockSize / 256));
		for (let i = block * blockSize; i < end; i += stride) {
			if (Number.isFinite(data[i])) values.push(data[i]);
		}
		values.sort((a, b) => a - b);
		floors[block] = values.length ? values[Math.floor(values.length * 0.5)] : -Infinity;
	}
	return floors;
}

export function detectSignals(data: Float32Array, config: DiscoveryConfig, refresh = false): DetectedSignal[] {
	if (data.length < 16 || !(config.sampleRate > 0)) return [];
	const binHz = config.sampleRate / data.length;
	const blockSize = Math.max(128, Math.round(1e6 / binHz));
	const floors = noiseFloor(data, blockSize);
	const excess = new Float32Array(data.length);
	const edge = Math.max(4, Math.ceil(data.length * 0.01));
	for (let i = edge; i < data.length - edge; i++) {
		const position = i / blockSize - 0.5;
		const left = Math.max(0, Math.min(floors.length - 1, Math.floor(position)));
		const right = Math.max(0, Math.min(floors.length - 1, Math.floor(position) + 1));
		const blend = position - Math.floor(position);
		const floor = floors[left] * (1 - blend) + floors[right] * blend;
		excess[i] = Number.isFinite(data[i]) && Number.isFinite(floor) ? data[i] - floor : 0;
		if (config.excludeDc && Math.abs(i - data.length / 2) <= 4) excess[i] = 0;
	}
	return collectRegions(excess, config, binHz, edge, refresh).filter((signal) => checkLocalNoise(data, signal, config, binHz, refresh));
}

/** Narrow peaks must stand above nearby noise, including raised noise patches. */
function checkLocalNoise(data: Float32Array, signal: DetectedSignal, config: DiscoveryConfig, binHz: number, refresh: boolean): boolean {
	if (signal.widthHz > 6000) return true;
	const centre = (signal.frequencyHz - config.centerHz + config.sampleRate / 2) / binHz;
	const radius = Math.max(16, Math.ceil(20000 / binHz));
	const guard = Math.max(4, Math.ceil((signal.widthHz / 2 + 1000) / binHz));
	const stride = Math.max(1, Math.floor(radius / 128));
	const neighbours: number[] = [];
	for (let i = Math.max(0, Math.ceil(centre - radius)); i < Math.min(data.length, centre + radius); i += stride) {
		if (Math.abs(i - centre) > guard && Number.isFinite(data[i])) neighbours.push(data[i]);
	}
	if (!neighbours.length) return false;
	neighbours.sort((a, b) => a - b);
	const floor = neighbours[Math.floor(neighbours.length / 2)];
	const half = (signal.widthHz / binHz - 1) / 2;
	let peak = 0;
	let occupied = 0;
	let seeds = 0;
	for (let i = Math.ceil(centre - half); i <= Math.floor(centre + half); i++) {
		const above = data[i] - floor;
		peak = Math.max(peak, above);
		if (above >= config.thresholdDb - 3) occupied++;
		if (above >= config.thresholdDb) seeds++;
	}
	signal.aboveNoiseDb = Math.min(signal.aboveNoiseDb, peak);
	return seeds > 0 && (refresh || seeds >= 2 || occupied >= 3 || peak >= config.thresholdDb + 6);
}

function collectRegions(
	excess: Float32Array,
	config: DiscoveryConfig,
	binHz: number,
	edge: number,
	refresh: boolean,
	stop = excess.length - edge,
	gapBins = Math.max(2, Math.floor(3000 / binHz)),
): DetectedSignal[] {
	const signals: DetectedSignal[] = [];
	const low = Math.max(1, config.thresholdDb - 3);
	let i = edge;
	while (i < stop && signals.length < 500) {
		if (excess[i] < low) {
			i++;
			continue;
		}
		const start = i;
		let end = i;
		let peak = 0;
		let seeds = 0;
		let occupied = 0;
		while (i < stop) {
			if (excess[i] >= low) {
				occupied++;
				end = i;
				peak = Math.max(peak, excess[i]);
				if (excess[i] >= config.thresholdDb) seeds++;
			} else if (i - end > gapBins) break;
			i++;
		}
		const widthHz = (end - start + 1) * binHz;
		// Isolated noise peaks connected by the notch allowance are not a broad signal.
		if (occupied / (end - start + 1) < 0.6) {
			// A nearby noise peak must not make a genuine narrow carrier fail
			// the broad-region coverage check. Reconsider contiguous islands.
			if (gapBins > 0) signals.push(...collectRegions(excess, config, binHz, start, refresh, end + 1, 0));
			continue;
		}
		if (widthHz < config.minWidthHz || !seeds || (!refresh && seeds < 2 && occupied < 3 && peak < config.thresholdDb + 6)) continue;
		signals.push({
			frequencyHz: config.centerHz - config.sampleRate / 2 + ((start + end) / 2) * binHz,
			widthHz,
			aboveNoiseDb: peak,
		});
	}
	return signals;
}
