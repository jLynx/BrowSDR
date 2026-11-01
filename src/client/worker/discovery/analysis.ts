import { detectSignals } from './detector';
import type { SignalTracker } from './tracker';
import type { DiscoveryFrame, DiscoveryResult } from './types';

export function analyseDiscoveryFrame(frame: DiscoveryFrame, tracker: SignalTracker): DiscoveryResult {
	const result: DiscoveryResult =
		frame.discover === false
			? { signals: [], binHz: frame.config.sampleRate / frame.data.length, frames: 0, time: frame.time }
			: tracker.process(frame);
	if (frame.rtk)
		result.rtk = {
			centerMHz: frame.config.centerHz / 1e6,
			sampleRate: frame.config.sampleRate,
			// RTK hints are independent of the generic tool's minimum-width setting.
			signals: detectSignals(frame.data, { ...frame.config, thresholdDb: 8, minWidthHz: 0, excludeDc: true }),
		};
	return result;
}
