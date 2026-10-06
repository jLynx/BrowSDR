import { IF_RATES } from './types';
import type { VfoParams } from './types';

export interface SharedBand {
	centerBin: number;
	centerFreq: number;
	vfos: number[];
}

export interface ChannelPlan {
	ratio: number;
	sampleRate: number;
	bands: SharedBand[];
	direct: number[];
}

export function planSharedBands(sampleRate: number, centerFreq: number, params: VfoParams[], enabled: boolean): ChannelPlan {
	const active = params.map((value, index) => ({ value, index })).filter(({ value }) =>
		value.enabled || value.pocsag || (value.rds && value.mode === 'wfm'));
	const direct = active.map(({ index }) => index);
	const fallback = { ratio: 1, sampleRate, bands: [], direct };
	if (!enabled || active.length < 3 || sampleRate < 4000000) return fallback;
	let ratio = 1;
	while (ratio < 32 && sampleRate / (ratio * 2) >= 1500000) ratio *= 2;
	if (ratio === 1) return fallback;
	const bandRate = sampleRate / ratio;
	const bands = new Map<number, SharedBand>();
	const remaining: number[] = [];
	for (const { value, index } of active) {
		const width = Math.max(value.bandwidth || 150000, IF_RATES[value.mode] || sampleRate);
		const offset = (value.freq - centerFreq) * 1000000;
		const centerBin = Math.round(offset / (bandRate / 2)) * (8192 / (ratio * 2));
		const bandOffset = centerBin * sampleRate / 8192;
		if (!Number.isFinite(offset) || Math.abs(offset) + width / 2 > sampleRate / 2 ||
			Math.abs(offset - bandOffset) + width / 2 > bandRate * 0.35 ||
			Math.abs(bandOffset) + bandRate / 2 > sampleRate / 2) {
			remaining.push(index);
			continue;
		}
		let band = bands.get(centerBin);
		if (!band) {
			band = { centerBin, centerFreq: centerFreq + bandOffset / 1000000, vfos: [] };
			bands.set(centerBin, band);
		}
		band.vfos.push(index);
	}
	if (active.length - remaining.length < 3) return fallback;
	return { ratio, sampleRate: bandRate, bands: [...bands.values()], direct: remaining };
}
