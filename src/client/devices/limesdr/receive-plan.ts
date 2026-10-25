import { MAX_SAMPLE_RATE } from './protocol';

/** LimeSuite's sub-30 MHz path: SXR at 30 MHz, followed by RxTSP mixing. */
export function receivePlan(frequency: number, sampleRate: number) {
	if (!Number.isFinite(frequency) || frequency < 100e3 || frequency > 3.8e9) {
		throw new RangeError('LimeSDR: frequency must be between 0.100 and 3800 MHz');
	}
	if (!Number.isFinite(sampleRate) || sampleRate < 1e6 || sampleRate > MAX_SAMPLE_RATE) {
		throw new RangeError(`LimeSDR: unsupported sample rate ${sampleRate}`);
	}
	const lo = Math.max(30e6, frequency);
	const offset = lo - frequency;
	let decimation = 0;
	// The offset band must fit before digital mixing and half-band decimation.
	while (decimation < 4 && offset + sampleRate / 2 >= (sampleRate * (2 << decimation)) / 2) decimation++;
	const oversample = 2 << decimation;
	if (offset + sampleRate / 2 >= (sampleRate * oversample) / 2) {
		const minimumRate = (2 * offset) / 31;
		throw new RangeError(
			`LimeSDR: ${(frequency / 1e6).toFixed(3)} MHz requires a sample rate above ${(minimumRate / 1e6).toFixed(3)} MS/s; select 2 MS/s or higher`,
		);
	}
	return { lo, offset, decimation, oversample, sampleRate, cgen: sampleRate * 4 * oversample, bandwidth: sampleRate + 2 * offset };
}
