import { mockRadioPayload } from './mock-packet';
import { mockSymbols } from './mock-symbols';

// SF7/BW500 kHz, 1 MSPS, CFO 630 Hz and +20 ppm sample timing error.
// All IQ samples are synthesized from the reviewed mock packet in this folder.
export function mockRtkIq(payload = mockRadioPayload(), options = {}) {
	const { oversample = 2, clockPpm = 20, preamble = 32, sync = [40, 36] } = options;
	const symbolLength = 128 * oversample;
	const symbols = mockSymbols(payload, options);
	const chirps = [
		...Array.from({ length: preamble }, () => ({ bin: 0, down: false, length: symbolLength })),
		...sync.map((bin) => ({ bin, down: false, length: symbolLength })),
		...Array.from({ length: 2 }, () => ({ bin: 0, down: true, length: symbolLength })),
		{ bin: 0, down: true, length: symbolLength / 4 },
		...symbols.map((bin) => ({ bin, down: false, length: symbolLength })),
	];
	const leading = 1024,
		skew = 1 + clockPpm / 1e6;
	const duration = chirps.reduce((total, chirp) => total + chirp.length, 0);
	const iq = new Int8Array(2 * (Math.ceil((duration + leading) * skew) + 2048));
	let index = 0,
		start = leading;
	for (let sample = Math.ceil(leading * skew); sample < Math.floor((duration + leading) * skew); sample++) {
		const at = sample / skew;
		while (at >= start + chirps[index].length) start += chirps[index++].length;
		const chirp = chirps[index],
			n = ((at - start) / oversample + chirp.bin) % 128;
		const phase = 2 * Math.PI * ((chirp.down ? -1 : 1) * ((n * n) / 256 - n / 2) + (630 * sample) / 1e6);
		iq[2 * sample] = Math.round(90 * Math.cos(phase));
		iq[2 * sample + 1] = Math.round(90 * Math.sin(phase));
	}
	return new Uint8Array(iq.buffer);
}
