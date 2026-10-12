import type { LimeGains, RxLevel, AutoGainMode } from './types';
import { gainAdjustment, gainAdjustmentReason } from './auto-gain-level';

const lnaSteps = [0, 3, 6, 9, 12, 15, 18, 21, 24, 25, 26, 27, 28, 29, 30];
const tiaDb = [0, 9, 12];
export const limeGainTotal = (gains: LimeGains) =>
	(lnaSteps.filter((db) => db <= gains.LNA).at(-1) ?? 0) + tiaDb[gains.TIA] + gains.PGA - 12;

/** Conservative gain staging; prioritize the LNA, then TIA, then baseband gain. */
export function limeGainProfile(total: number, mode: AutoGainMode = 'balanced'): LimeGains {
	const budget = Math.max(-12, Math.min(61, Math.round(total)));
	if (mode === 'strong') {
		const lna = lnaSteps.find((db) => db >= Math.max(0, budget - 31)) ?? 30;
		const tia = tiaDb.findIndex((db) => budget - lna - db <= 19);
		return { LNA: lna, TIA: tia, PGA: budget - lna - tiaDb[tia] + 12 };
	}
	const lna = lnaSteps.filter((db) => db <= Math.min(30, Math.max(0, budget + (mode === 'sensitivity' ? 12 : 0)))).at(-1) ?? 0;
	const remaining = budget - lna;
	const tia = remaining >= 12 ? 2 : remaining >= 9 ? 1 : 0;
	return { LNA: lna, TIA: tia, PGA: Math.max(0, Math.min(31, budget - lna - tiaDb[tia] + 12)) };
}

export function nextLimeGain(
	gains: LimeGains,
	level: RxLevel,
	mode: AutoGainMode = 'balanced',
): { gains: LimeGains; reason: string; done: boolean } {
	const total = limeGainTotal(gains);
	const change = gainAdjustment(level, mode);
	const next = change || mode !== 'balanced' ? limeGainProfile(total + change, mode) : gains;
	const unchanged = next.LNA === gains.LNA && next.TIA === gains.TIA && next.PGA === gains.PGA;
	return {
		gains: next,
		done: unchanged,
		reason: !unchanged && !change ? 'Redistributing gain for receiver preference' : gainAdjustmentReason(change, unchanged, level),
	};
}
