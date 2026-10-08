import { makeDefaultVfo } from '../../src/client/app/constants';

// Frequencies from the 27-VFO configuration that exposed the UI regression.
const frequencies = [
	447.735, 414.772, 415.675, 416.175, 455.569, 455.756, 455.881,
	455.981, 456.08, 456.131, 456.318, 456.507, 456.756, 457.018,
	457.093, 457.681, 457.88, 457.895, 457.981, 458.146, 463.393,
	462.133, 426.593, 418.275, 417.413, 414.275, 425.594,
];

export function makePerformanceVfos() {
	return frequencies.map(freq => ({
		...makeDefaultVfo(freq), enabled: true, mode: 'dsd', bandwidth: 12500,
		snapInterval: 2500, deEmphasis: 'none', lowPass: false,
		volume: freq === 455.981 ? 79 : 50,
	}));
}
