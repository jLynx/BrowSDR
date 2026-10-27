import { demodulateSideband } from '@/worker/decoders/ssb';
import type { AnalogDemodState } from './analog-demod.types';

/** Mean-magnitude signal level in dB over the channel-filtered IQ, used for
 * auto-squelch. Stores the value on `state.squelchDb` and returns it. */
export function measureSquelch(numDemodSamples: number, ddcOut: Float32Array, state: AnalogDemodState): number {
	let squelchMag = 0;
	for (let i = 0; i < numDemodSamples; i++) {
		const dI = ddcOut[i * 2];
		const dQ = ddcOut[i * 2 + 1];
		squelchMag += Math.sqrt(dI * dI + dQ * dQ);
	}
	squelchMag /= numDemodSamples;
	const squelchDb = 10 * Math.log10(squelchMag + 1e-12);
	state.squelchDb = squelchDb;
	return squelchDb;
}

/** Demodulate AM / SSB / CW / RAW from channel-filtered IQ into audio-rate
 * samples. FM is handled separately (in the WASM pipeline). */
export function demodulateAnalogAudio(
	mode: string,
	numDemodSamples: number,
	ddcOut: Float32Array,
	ifRate: number,
	audioDemodRateSamples: Float32Array,
	bw: number,
	state: AnalogDemodState,
): void {
	if (mode === 'am') {
		for (let i = 0; i < numDemodSamples; i++) {
			const dI = ddcOut[i * 2];
			const dQ = ddcOut[i * 2 + 1];
			const mag = Math.sqrt(dI * dI + dQ * dQ);
			const dcAlpha = 0.9999;
			state.dcAvg = dcAlpha * state.dcAvg + (1 - dcAlpha) * mag;
			const demodSample = mag - state.dcAvg;
			audioDemodRateSamples[i] = demodSample * agcScale(state, ifRate, Math.abs(demodSample));
		}
	} else if (mode === 'usb' || mode === 'lsb' || mode === 'dsb') {
		demodulateSideband(ddcOut, audioDemodRateSamples, mode, bw, ifRate, state);
	} else if (mode === 'cw') {
		for (let i = 0; i < numDemodSamples; i++) {
			const dI = ddcOut[i * 2];
			const dQ = ddcOut[i * 2 + 1];
			const phaseInc = (700 / ifRate) * 2 * Math.PI;
			state.ssbPhase += phaseInc;
			if (state.ssbPhase > Math.PI) state.ssbPhase -= 2 * Math.PI;
			if (state.ssbPhase < -Math.PI) state.ssbPhase += 2 * Math.PI;
			const demodSample = dI * Math.cos(state.ssbPhase) - dQ * Math.sin(state.ssbPhase);
			audioDemodRateSamples[i] = demodSample * agcScale(state, ifRate, Math.abs(demodSample));
		}
	} else if (mode === 'raw') {
		for (let i = 0; i < numDemodSamples; i++) {
			audioDemodRateSamples[i] = ddcOut[i * 2];
		}
	} else {
		audioDemodRateSamples.fill(0);
	}
}

/** Update the AGC envelope with one sample's magnitude and return its scale. */
function agcScale(state: AnalogDemodState, ifRate: number, absSample: number): number {
	const agcAttack = 50.0 / ifRate;
	const agcDecay = 5.0 / ifRate;
	if (absSample > state.agcGain) {
		state.agcGain = state.agcGain * (1 - agcAttack) + absSample * agcAttack;
	} else {
		state.agcGain = state.agcGain * (1 - agcDecay) + absSample * agcDecay;
	}
	return state.agcGain > 1e-6 ? 0.5 / state.agcGain : 1.0;
}
