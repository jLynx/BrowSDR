import type { AppInstance } from '@/app/core/receiver.types';
import type { DiscoveryResult, DetectedSignal } from '@/worker/discovery/types';

export function rtkSurveyActive(receiver: AppInstance): boolean {
	return receiver.running && receiver.remoteMode !== 'client' && receiver.vfos.some((vfo) => vfo.rtk && vfo.rtkProfile === 'scan');
}

/** Width is a ranking hint: a short LoRa burst can look narrower than its PHY. */
export function rankRtkCandidates(signals: DetectedSignal[]): number[] {
	const score = (signal: DetectedSignal) => signal.aboveNoiseDb + (signal.widthHz >= 100000 ? 6 : 0);
	const frequencies: number[] = [];
	for (const signal of signals
		.filter(
			(signal) =>
				Number.isFinite(signal.frequencyHz) &&
				Number.isFinite(signal.widthHz) &&
				Number.isFinite(signal.aboveNoiseDb) &&
				signal.frequencyHz >= 900e6 &&
				signal.frequencyHz <= 930e6 &&
				signal.widthHz > 0 &&
				signal.widthHz <= 700000,
		)
		.sort((a, b) => score(b) - score(a))) {
		const frequency = Math.round(signal.frequencyHz / 1000) / 1000;
		if (!frequencies.some((previous) => Math.abs(previous - frequency) < 0.05)) frequencies.push(frequency);
		if (frequencies.length >= 32) break;
	}
	return frequencies;
}

export function feedRtkCandidates(receiver: AppInstance, result: DiscoveryResult): void {
	if (!rtkSurveyActive(receiver) || !result.rtk || Date.now() - result.time > 2000) return;
	const { centerMHz, sampleRate, signals } = result.rtk;
	if (centerMHz !== receiver.radio.centerFreq || sampleRate !== receiver.radio.sampleRate) return;
	const scouts = receiver.vfos.filter((vfo) => vfo.rtk && vfo.rtkProfile === 'scan');
	const inRange = signals.filter((signal) =>
		scouts.some((vfo) => signal.frequencyHz >= (vfo.rtkScanStart ?? 915) * 1e6 && signal.frequencyHz <= (vfo.rtkScanEnd ?? 928) * 1e6),
	);
	Promise.resolve(receiver.backend.setRtkDiscoveryCandidates(rankRtkCandidates(inRange), centerMHz, sampleRate)).catch((error: unknown) =>
		console.error('RTK activity hints:', error),
	);
}
