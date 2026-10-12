import { detectSignals } from './detector';
import type { DiscoveryFrame, DiscoveryResult, TrackedDiscoverySignal, DetectedSignal } from './types';

export class SignalTracker {
	private signals: TrackedDiscoverySignal[] = [];
	private nextId = 1;
	private frames = 0;

	process({ data, config, time }: DiscoveryFrame): DiscoveryResult {
		this.frames++;
		const binHz = config.sampleRate / data.length;
		this.signals = this.signals.filter(
			(signal) => time - signal.lastSeen <= (signal.hits >= 2 || signal.aboveNoiseDb >= config.thresholdDb + 6 ? 120000 : 500),
		);
		for (const signal of this.signals) {
			signal.active = false;
			signal.observations++;
		}
		for (const detection of detectSignals(data, config)) this.track(detection, time, binHz);
		// Hysteresis keeps confirmed carriers live through small strength changes.
		// The lower threshold can refresh an existing entry, never discover a new one.
		for (const detection of detectSignals(data, { ...config, thresholdDb: config.thresholdDb - 3 }, true)) {
			this.track(detection, time, binHz, config.thresholdDb);
		}
		const confirmed = this.signals.filter((signal) => signal.hits >= 2 || signal.aboveNoiseDb >= config.thresholdDb + 6);
		return { signals: confirmed.sort((a, b) => a.frequencyHz - b.frequencyHz), binHz, frames: this.frames, time };
	}

	private track(detection: DetectedSignal, time: number, binHz: number, refreshThreshold?: number): void {
		let best: TrackedDiscoverySignal | undefined;
		let distance = Infinity;
		for (const signal of this.signals) {
			if (refreshThreshold !== undefined && signal.hits < 2 && signal.aboveNoiseDb < refreshThreshold + 6) continue;
			const delta = Math.abs(signal.estimatedFrequencyHz - detection.frequencyHz);
			// A threshold-dependent centre can move by more than half either width
			// while both estimates still describe overlapping parts of one signal.
			const tolerance =
				refreshThreshold === undefined
					? Math.max(binHz * 4, (signal.widthHz + detection.widthHz) * 0.5)
					: Math.max(binHz * 1.5, signal.widthHz * 0.25);
			if (signal.active) {
				if (refreshThreshold !== undefined && delta <= tolerance) return;
				continue;
			}
			if (delta <= tolerance && delta < distance) {
				best = signal;
				distance = delta;
			}
		}
		if (best) {
			// Weaker refreshes cannot walk a confirmed band across random noise.
			if (refreshThreshold === undefined) {
				best.estimatedFrequencyHz += (detection.frequencyHz - best.estimatedFrequencyHz) * 0.2;
				best.widthHz += (detection.widthHz - best.widthHz) * 0.2;
			}
			best.aboveNoiseDb = detection.aboveNoiseDb;
			best.lastSeen = time;
			best.hits++;
			best.active = true;
		} else if (refreshThreshold === undefined && this.signals.length < 500) {
			// Broad broadcast FM spectra can have asymmetric threshold edges.
			const broadcastFm = detection.frequencyHz >= 88e6 && detection.frequencyHz <= 108e6 && detection.widthHz >= 50000;
			const stepHz = broadcastFm ? 100000 : detection.widthHz >= 20000 ? 1000 : 100;
			this.signals.push({
				...detection,
				frequencyHz: Math.round(detection.frequencyHz / stepHz) * stepHz,
				estimatedFrequencyHz: detection.frequencyHz,
				id: this.nextId++,
				firstSeen: time,
				lastSeen: time,
				hits: 1,
				observations: 1,
				active: true,
			});
		}
	}
}
