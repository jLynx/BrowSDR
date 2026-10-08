export const SPECTRUM_RANGE_VERSION = 1;
export const DEFAULT_FFT_SIZE = 65536;

/** Preserve the original display contrast after correcting FFT power by 1/N. */
export function normalizedSpectrumRange(fftSize = DEFAULT_FFT_SIZE, minDB = -70, maxDB = 0) {
	const offset = 10 * Math.log10(fftSize);
	return { minDB: minDB - offset, maxDB: maxDB - offset };
}

export const DEFAULT_SPECTRUM_RANGE = normalizedSpectrumRange();
