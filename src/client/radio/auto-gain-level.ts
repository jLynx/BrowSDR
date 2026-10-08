import type { RxLevel } from './types';

/** Target receiver level while retaining headroom for peaks across the capture. */
export function gainAdjustment(level: RxLevel): number {
	if (![level.rmsDbfs, level.peakDbfs, level.clippedFraction].every(Number.isFinite) || level.samples < 100)
		throw new Error('Invalid receiver level measurement');
	if (level.rmsDbfs <= -100) throw new Error('Receiver samples are silent; check the USB stream');
	if (level.clippedFraction > 0.0001 || level.peakDbfs > -3) return -6;
	const delta = Math.min(-22 - level.rmsDbfs, -6 - level.peakDbfs);
	return delta < -2 ? Math.max(-6, Math.floor(delta)) : delta > 3 ? Math.min(3, Math.floor(delta)) : 0;
}

export function gainAdjustmentReason(change: number, done: boolean, level: RxLevel): string {
	return done
		? change
			? 'Gain limit reached'
			: 'Levels settled'
		: level.clippedFraction > 0.0001 || level.peakDbfs > -3
			? 'Reducing gain: ADC overload'
			: change < 0
				? 'Reducing gain for headroom'
				: 'Increasing gain';
}
