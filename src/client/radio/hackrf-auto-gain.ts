import type { HackRFGains, RxLevel, AutoGainMode } from './types';
import { gainAdjustment, gainAdjustmentReason, receiverOverloaded } from './auto-gain-level';

// RF amp gain varies with frequency; use 10 dB only to stage a conservative
// transition, then measure the actual ADC level again.
const ampEstimate = 10;
export const hackrfGainTotal = (gains: HackRFGains) => gains.LNA + gains.VGA + (gains['Amp (14dB)'] ? ampEstimate : 0);

/** Balance IF and baseband gain, using HackRF's 8 dB LNA / 2 dB VGA steps. */
export function hackrfGainProfile(total: number, mode: AutoGainMode = 'balanced'): HackRFGains {
	const budget = Math.max(0, Math.min(102, Math.floor(total / 2) * 2));
	let best: HackRFGains = { LNA: 0, VGA: Math.min(62, budget) };
	let imbalance = Infinity;
	for (let lna = 0; lna <= 40; lna += 8) {
		const vga = budget - lna;
		if (vga < 0 || vga > 62) continue;
		const difference = mode === 'sensitivity' ? 40 - lna : mode === 'strong' ? lna : Math.abs(lna - vga);
		if (difference < imbalance) {
			best = { LNA: lna, VGA: vga };
			imbalance = difference;
		}
	}
	return best;
}

export function nextHackRFGain(gains: HackRFGains, level: RxLevel, mode: AutoGainMode = 'balanced', allowAmp = true) {
	const change = gainAdjustment(level, mode);
	const total = hackrfGainTotal(gains);
	const amp = gains['Amp (14dB)'] ? 1 : 0;
	const overloaded = receiverOverloaded(level);
	const nextAmp = amplifierPreference(gains, mode, change, overloaded || !allowAmp);
	const next =
		change || nextAmp !== amp || mode !== 'balanced'
			? { ...hackrfGainProfile(total + change - nextAmp * ampEstimate, mode), 'Amp (14dB)': nextAmp }
			: gains;
	const done = next.LNA === gains.LNA && next.VGA === gains.VGA && nextAmp === amp;
	return {
		gains: next,
		done,
		reason:
			nextAmp !== amp
				? nextAmp
					? 'Enabling RF amplifier for weak input'
					: overloaded
						? 'Disabling RF amplifier: ADC overload'
						: 'Disabling RF amplifier for headroom'
				: !done && !change
					? 'Redistributing gain for receiver preference'
					: gainAdjustmentReason(change, done, level),
	};
}

function amplifierPreference(gains: HackRFGains, mode: AutoGainMode, change: number, blocked: boolean) {
	if (blocked || mode === 'strong') return 0;
	if (mode === 'sensitivity') return Number(hackrfGainTotal(gains) + change >= ampEstimate);
	return change > 0 && gains.LNA + gains.VGA >= 72 ? 1 : Number(!!gains['Amp (14dB)']);
}
