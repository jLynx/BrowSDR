export function normalizeFrequencyShiftMhz(value: unknown): number {
	const shift = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(shift) ? shift : 0;
}

/**
 * Convert a user-facing RF frequency to the frequency the SDR hardware tunes.
 *
 * A negative shift is used for a typical upconverter. For example, a 125 MHz
 * upconverter uses a -125 MHz shift, so displayed 7 MHz tunes the SDR to
 * 132 MHz.
 */
export function displayToDeviceFrequencyHz(displayFrequencyMhz: number, frequencyShiftMhz: unknown): number {
	return (displayFrequencyMhz - normalizeFrequencyShiftMhz(frequencyShiftMhz)) * 1e6;
}
