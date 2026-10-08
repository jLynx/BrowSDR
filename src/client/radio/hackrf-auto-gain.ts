import type { HackRFGains, RxLevel } from './types';
import { gainAdjustment, gainAdjustmentReason } from './auto-gain-level';

// RF amp gain varies with frequency; use 10 dB only to stage a conservative
// transition, then measure the actual ADC level again.
const ampEstimate = 10;
export const hackrfGainTotal = (gains: HackRFGains) => gains.LNA + gains.VGA + (gains['Amp (14dB)'] ? ampEstimate : 0);

/** Balance IF and baseband gain, using HackRF's 8 dB LNA / 2 dB VGA steps. */
export function hackrfGainProfile(total: number): HackRFGains {
	const budget = Math.max(0, Math.min(102, Math.floor(total / 2) * 2));
	let best: HackRFGains = { LNA: 0, VGA: Math.min(62, budget) };
	let imbalance = Infinity;
	for (let lna = 0; lna <= 40; lna += 8) {
		const vga = budget - lna;
		if (vga < 0 || vga > 62) continue;
		const difference = Math.abs(lna - vga);
		if (difference < imbalance) {
			best = { LNA: lna, VGA: vga };
			imbalance = difference;
		}
	}
	return best;
}

export function nextHackRFGain(gains: HackRFGains, level: RxLevel) {
	const change = gainAdjustment(level);
	const total = hackrfGainTotal(gains);
	const amp = gains['Amp (14dB)'] ? 1 : 0;
	const overloaded = level.clippedFraction > 0.0001 || level.peakDbfs > -3;
	// Remove the earliest gain stage first on overload. Otherwise reserve the
	// RF amp for weak input after substantial IF/baseband gain has been tried.
	const nextAmp = overloaded ? 0 : change > 0 && gains.LNA + gains.VGA >= 72 ? 1 : amp;
	const next = change ? { ...hackrfGainProfile(total + change - nextAmp * ampEstimate), 'Amp (14dB)': nextAmp } : gains;
	const done = hackrfGainTotal(next) === total;
	return {
		gains: next,
		done: done && nextAmp === amp,
		reason:
			nextAmp !== amp
				? nextAmp
					? 'Enabling RF amplifier for weak input'
					: 'Disabling RF amplifier: ADC overload'
				: gainAdjustmentReason(change, done, level),
	};
}
