import type { SurveyChannel } from './types';

/** Channel centres, with enough captured bandwidth for both supported LoRa PHYs. */
export function surveyPlan(start: number, end: number, rate: number, center: number): SurveyChannel[] {
	if (![start, end, rate, center].every(Number.isFinite) || start < 900 || end > 930 || start > end)
		throw new Error('Choose an ordered RTK frequency range between 900 and 930 MHz.');
	if (rate < 1000000 || Math.max(Math.abs(start - center), Math.abs(end - center)) * 1e6 + 300000 > rate / 2 + 1)
		throw new Error('The entire discovery range, plus 300 kHz at each edge, must be inside the received band at 1 MSPS or higher.');
	// At lower rates, a temporary RTK2 channel listens alongside the scout.
	// The scout also covers complete laps when that extra channel is unavailable.
	const anchors: SurveyChannel[] = [
		{ frequencyMHz: 923.118, seconds: 1.37 },
		{ frequencyMHz: 915.191, seconds: 6.37 },
		{ frequencyMHz: 915.401, seconds: 16.37 },
		{ frequencyMHz: 921.401, seconds: 16.37 },
		{ frequencyMHz: 921.791, seconds: 18.37 },
	].filter(({ frequencyMHz }) => frequencyMHz >= start && frequencyMHz <= end);
	const steps = Math.max(1, Math.ceil(Math.round((end - start) * 1e6) / 50000));
	for (let i = 0; i <= steps; i++) {
		const frequencyMHz = start + ((end - start) * i) / steps;
		if (!anchors.some((channel) => Math.abs(channel.frequencyMHz - frequencyMHz) < 0.000001)) anchors.push({ frequencyMHz, seconds: 1.37 });
	}
	return anchors;
}

export function priorityPlan(start: number, end: number, rate = 20000000): SurveyChannel[] {
	if (rate > 20000000) return [];
	return [{ frequencyMHz: 921.791, seconds: 18.37 }].filter(({ frequencyMHz }) => frequencyMHz >= start && frequencyMHz <= end);
}
