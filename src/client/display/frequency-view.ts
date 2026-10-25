import { minimumDisplayFrequencyMhz } from '@/radio/frequency-shift';

/** Crop the FFT view to physical RF frequencies, preserving the original bin coordinates. */
export function frequencyView(
	radio: { centerFreq: number; sampleRate: number; frequencyShift?: number },
	view: { zoomScale: number; zoomOffset: number },
) {
	const span = radio.sampleRate / 1e6;
	const floor = minimumDisplayFrequencyMhz(radio.frequencyShift);
	if (!Number.isFinite(radio.centerFreq) || !Number.isFinite(span) || span <= 0) {
		return { zoomScale: 1, zoomOffset: 0, minFreq: floor, maxFreq: floor };
	}
	const baseMin = radio.centerFreq - span / 2;
	const minimumOffset = Math.max(0, Math.min(1 - Number.EPSILON, (floor - baseMin) / span));
	const minimumScale = 1 / (1 - minimumOffset);
	const zoomScale = Math.max(minimumScale, Number.isFinite(view.zoomScale) ? view.zoomScale : 1);
	const zoomOffset = Math.max(minimumOffset, Math.min(1 - 1 / zoomScale, Number.isFinite(view.zoomOffset) ? view.zoomOffset : 0));
	return {
		zoomScale,
		zoomOffset,
		minFreq: Math.max(floor, baseMin + span * zoomOffset),
		maxFreq: Math.max(floor, baseMin + span * (zoomOffset + 1 / zoomScale)),
	};
}
