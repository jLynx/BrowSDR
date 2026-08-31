import { describe, expect, it } from 'vitest';
import { displayToDeviceFrequencyHz, normalizeFrequencyShiftMhz } from '../src/client/frequency-shift';

describe('frequency shift', () => {
	it('leaves the hardware frequency unchanged when disabled', () => {
		expect(displayToDeviceFrequencyHz(100, 0)).toBe(100_000_000);
	});

	it('supports a typical upconverter shift', () => {
		expect(displayToDeviceFrequencyHz(7, -125)).toBe(132_000_000);
	});

	it('supports a downconverter shift', () => {
		expect(displayToDeviceFrequencyHz(1_296, 1_168)).toBe(128_000_000);
	});

	it('treats an empty or invalid persisted shift as zero', () => {
		expect(normalizeFrequencyShiftMhz('')).toBe(0);
		expect(normalizeFrequencyShiftMhz('invalid')).toBe(0);
	});
});
