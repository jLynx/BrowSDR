/** Mutable demod state carried across chunks by the non-FM analog paths. */
export interface AnalogDemodState {
	dcAvg: number;
	agcGain: number;
	ssbPhase: number;
	squelchDb?: number;
}
