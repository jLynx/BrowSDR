export function normalizeFrequencyShiftMhz(value: unknown): number {
	const shift = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(shift) ? shift : 0;
}

/** Both the displayed RF frequency and the hardware frequency must be non-negative. */
export function minimumDisplayFrequencyMhz(frequencyShiftMhz: unknown): number {
	return Math.max(0, normalizeFrequencyShiftMhz(frequencyShiftMhz));
}

export function isValidDisplayFrequencyMhz(frequencyMhz: number, frequencyShiftMhz: unknown = 0): boolean {
	return Number.isFinite(frequencyMhz) && frequencyMhz >= minimumDisplayFrequencyMhz(frequencyShiftMhz);
}

/**
 * Convert a user-facing RF frequency to the frequency the SDR hardware tunes.
 *
 * A negative shift is used for a typical upconverter. For example, a 125 MHz
 * upconverter uses a -125 MHz shift, so displayed 7 MHz tunes the SDR to
 * 132 MHz.
 */
export function displayToDeviceFrequencyHz(displayFrequencyMhz: number, frequencyShiftMhz: unknown): number {
	if (!isValidDisplayFrequencyMhz(displayFrequencyMhz, frequencyShiftMhz)) {
		throw new RangeError('RF and SDR frequencies must be finite and non-negative');
	}
	return (displayFrequencyMhz - normalizeFrequencyShiftMhz(frequencyShiftMhz)) * 1e6;
}
