/** Offset from the suppressed carrier to the center of the selected sideband. */
export function sidebandOffsetHz(mode: string, bandwidth: number): number {
	if (mode === 'usb') return bandwidth / 2;
	if (mode === 'lsb') return -bandwidth / 2;
	return 0;
}

interface SidebandState {
	ssbPhase?: number;
	agcGain?: number;
}

/** Restore carrier-relative audio after the DDC has filtered the sideband center. */
export function demodulateSideband(
	iq: Float32Array, output: Float32Array, mode: string,
	bandwidth: number, sampleRate: number, state: SidebandState,
): void {
	const phaseInc = 2 * Math.PI * sidebandOffsetHz(mode, bandwidth) / sampleRate;
	const attack = 50 / sampleRate;
	const decay = 5 / sampleRate;
	let phase = state.ssbPhase ?? 0;
	let gain = state.agcGain ?? 1;
	for (let i = 0; i < output.length; i++) {
		// The DDC translates by -(carrier + sideband offset). Translate back
		// by +sideband offset before taking the real part (product detection).
		const sample = iq[2 * i] * Math.cos(phase) - iq[2 * i + 1] * Math.sin(phase);
		phase += phaseInc;
		if (phase > Math.PI) phase -= 2 * Math.PI;
		if (phase < -Math.PI) phase += 2 * Math.PI;
		const magnitude = Math.abs(sample);
		const alpha = magnitude > gain ? attack : decay;
		gain += (magnitude - gain) * alpha;
		output[i] = sample * (gain > 1e-6 ? 0.5 / gain : 1);
	}
	state.ssbPhase = phase;
	state.agcGain = gain;
}
