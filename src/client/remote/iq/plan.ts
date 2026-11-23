import { IF_RATES } from '@/worker/runtime/constants';
import type { VfoParams } from '@/worker/runtime/types';
import { rtl433SampleRate } from '@/worker/decoders/rtl433';
import { sidebandOffsetHz } from '@/worker/decoders/ssb';
import { PAGER_RX_BANDWIDTH } from '@/worker/decoders/pager-bandwidth';
import type { IqSlicePlan } from './types';

export function needsSlice(p: VfoParams): boolean {
	return !!(
		p.enabled ||
		p.mode === 'hdradio' ||
		p.pocsag ||
		p.gsc ||
		p.flex ||
		(p.rds && p.mode === 'wfm') ||
		p.rtl433 ||
		p.adsb ||
		p.ais ||
		p.radiosonde ||
		p.rtk ||
		p.ble ||
		p.acars ||
		p.aprs
	);
}

/** Transport enough RF for every enabled decoder, independently of the audio filter. */
export function planIqSlice(p: VfoParams, sourceRate: number, sourceCenter: number): IqSlicePlan | null {
	if (
		!needsSlice(p) ||
		!Number.isFinite(sourceCenter) ||
		!Number.isFinite(sourceRate) ||
		sourceRate <= 0 ||
		!Number.isFinite(p.freq) ||
		!Number.isFinite(p.bandwidth) ||
		p.bandwidth <= 0 ||
		!Object.hasOwn(IF_RATES, p.mode)
	)
		return null;
	const fullBand = !!(p.rtk && (p.rtkProfile === 'scan' || p.rtkProfile === 'auto' || p.rtkFollowHops));
	if (fullBand) return { centerFreq: sourceCenter, sampleRate: sourceRate, bandwidth: sourceRate, fullBand: true };
	const { bandwidth, minimumRate, decoderSpan } = sliceRequirements(p);
	const required = Math.max(minimumRate, bandwidth / 0.8);
	const rates = [50000, 100000, 250000, 500000, 1000000, 2000000, 3000000, 4000000, 8000000, 16000000];
	const sampleRate = Math.min(sourceRate, rates.find((rate) => rate >= required) ?? sourceRate);
	const span = Math.max(bandwidth, decoderSpan);
	if (span > sampleRate || minimumRate > sourceRate || Math.abs(p.freq - sourceCenter) * 1e6 + span / 2 > sourceRate / 2) return null;
	// Near a capture edge, move the slice center inward without losing the requested passband.
	const halfSpan = (sourceRate - sampleRate) / 2e6;
	const centerFreq = Math.max(sourceCenter - halfSpan, Math.min(sourceCenter + halfSpan, p.freq));
	if (Math.abs(p.freq - centerFreq) * 1e6 + span / 2 > sampleRate / 2) return null;
	return { centerFreq, sampleRate, bandwidth: Math.min(sampleRate, bandwidth + 2e6 * Math.abs(p.freq - centerFreq)), fullBand: false };
}

function sliceRequirements(p: VfoParams) {
	const offset = sidebandOffsetHz(p.mode, p.bandwidth);
	let bandwidth = p.bandwidth + Math.abs(offset) * 2;
	let minimumRate = IF_RATES[p.mode];
	let decoderSpan = 0;
	if (p.mode === 'wfm' && p.stereo) bandwidth = Math.max(bandwidth, 200000);
	if (p.rds && p.mode === 'wfm') bandwidth = Math.max(bandwidth, 250000);
	if (p.mode === 'hdradio') bandwidth = Math.max(bandwidth, 400000);
	for (const protocol of ['pocsag', 'gsc', 'flex'] as const) {
		if (p[protocol]) bandwidth = Math.max(bandwidth, PAGER_RX_BANDWIDTH[protocol]);
	}
	if (p.rtl433) {
		const rate = rtl433SampleRate(p.rtl433SampleRate);
		bandwidth = Math.max(bandwidth, rate * 0.8);
		minimumRate = Math.max(minimumRate, rate);
	}
	if (p.adsb || p.ble) bandwidth = Math.max(bandwidth, 2000000);
	if (p.rtk) bandwidth = Math.max(bandwidth, 1000000);
	if (p.ais || p.radiosonde || p.acars || p.aprs) {
		minimumRate = Math.max(minimumRate, 48000);
		decoderSpan = 48000;
		bandwidth = Math.max(bandwidth, p.ais || p.acars ? 25000 : p.radiosonde ? 20000 : 16000);
	}
	return { bandwidth, minimumRate, decoderSpan };
}
