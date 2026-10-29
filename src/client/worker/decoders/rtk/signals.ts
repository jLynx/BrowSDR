import type { RtcmSignalObservation } from './types';

// RTCM MSM signal IDs, grouped by their actual GNSS frequencies.
// Primary/secondary follows the common multi-GNSS L1/L2 convention.
const bands: Record<string, Array<[string, NonNullable<RtcmSignalObservation['group']>, number[]]>> = {
	GPS: [
		['L1', 'primary', [2, 3, 4, 30, 31, 32]],
		['L2', 'secondary', [8, 9, 10, 15, 16, 17]],
		['L5', 'other', [22, 23, 24]],
	],
	GLONASS: [
		['G1', 'primary', [2, 3]],
		['G2', 'secondary', [8, 9]],
	],
	Galileo: [
		['E1', 'primary', [2, 3, 4, 5, 6]],
		['E5b', 'secondary', [14, 15, 16]],
		['E5a', 'other', [22, 23, 24]],
		['E5', 'other', [18, 19, 20]],
		['E6', 'other', [8, 9, 10, 11, 12]],
	],
	BeiDou: [
		['B1I', 'primary', [2, 3, 4]],
		['B1C', 'primary', [30, 31, 32]],
		['B2I', 'secondary', [14, 15, 16]],
		['B2b', 'secondary', [25]],
		['B2a', 'other', [22, 23, 24]],
		['B3I', 'other', [8, 9, 10]],
	],
	QZSS: [
		['L1', 'primary', [2, 30, 31, 32]],
		['L2', 'secondary', [15, 16, 17]],
		['L5', 'other', [22, 23, 24]],
		['L6', 'other', [9, 10, 11]],
	],
	SBAS: [
		['L1', 'primary', [2]],
		['L5', 'other', [22, 23, 24]],
	],
	NavIC: [
		['L5', 'other', [22]],
		['S', 'other', [8]],
	],
};

export function signalBand(constellation: string, signal: number): Pick<RtcmSignalObservation, 'band' | 'group'> {
	const band = bands[constellation]?.find((entry) => entry[2].includes(signal));
	return band ? { band: band[0], group: band[1] } : {};
}
