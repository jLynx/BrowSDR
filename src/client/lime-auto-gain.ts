import type { RxLevel } from './sdr-device';
import { gainAdjustment, gainAdjustmentReason } from './auto-gain-level';

export type LimeGains = { LNA: number; TIA: number; PGA: number };
const lnaSteps = [0, 3, 6, 9, 12, 15, 18, 21, 24, 25, 26, 27, 28, 29, 30];
const tiaDb = [0, 9, 12];
export const limeGainTotal = (gains: LimeGains) =>
	(lnaSteps.filter(db => db <= gains.LNA).at(-1) ?? 0) + tiaDb[gains.TIA] + gains.PGA - 12;

/** Conservative gain staging; prioritize the LNA, then TIA, then baseband gain. */
export function limeGainProfile(total: number): LimeGains {
	const budget = Math.max(-12, Math.min(61, Math.round(total)));
	const lna = lnaSteps.filter(db => db <= Math.min(30, Math.max(0, budget))).at(-1) ?? 0;
	const remaining = budget - lna;
	const tia = remaining >= 12 ? 2 : remaining >= 9 ? 1 : 0;
	return { LNA: lna, TIA: tia, PGA: Math.max(0, Math.min(31, budget - lna - tiaDb[tia] + 12)) };
}

export function nextLimeGain(gains: LimeGains, level: RxLevel): { gains: LimeGains; reason: string; done: boolean } {
	const total = limeGainTotal(gains);
	const change = gainAdjustment(level);
	const next = change ? limeGainProfile(total + change) : gains;
	const unchanged = limeGainTotal(next) === total;
	return { gains: next, done: unchanged, reason: gainAdjustmentReason(change, unchanged, level) };
}
