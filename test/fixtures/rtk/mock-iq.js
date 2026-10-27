import { mockRadioPayload } from './mock-packet';
import { mockSymbols } from './mock-symbols';

// SF7/BW500 kHz, 1 MSPS, CFO 630 Hz and +20 ppm sample timing error.
// All IQ samples are synthesized from the reviewed mock packet in this folder.
export function mockRtkIq(payload = mockRadioPayload()) {
	const symbols = mockSymbols(payload);
	const chirps = [
		...Array.from({ length: 32 }, () => ({ bin: 0, down: false, length: 256 })),
		...[40, 36].map((bin) => ({ bin, down: false, length: 256 })),
		...Array.from({ length: 2 }, () => ({ bin: 0, down: true, length: 256 })),
		{ bin: 0, down: true, length: 64 },
		...symbols.map((bin) => ({ bin, down: false, length: 256 })),
	];
	const leading = 1024,
		skew = 1 + 20e-6;
	const duration = chirps.reduce((total, chirp) => total + chirp.length, 0);
	const iq = new Int8Array(2 * (Math.ceil((duration + leading) * skew) + 2048));
	let index = 0,
		start = leading;
	for (let sample = Math.ceil(leading * skew); sample < Math.floor((duration + leading) * skew); sample++) {
		const at = sample / skew;
		while (at >= start + chirps[index].length) start += chirps[index++].length;
		const chirp = chirps[index],
			n = ((at - start) / 2 + chirp.bin) % 128;
		const phase = 2 * Math.PI * ((chirp.down ? -1 : 1) * ((n * n) / 256 - n / 2) + (630 * sample) / 1e6);
		iq[2 * sample] = Math.round(90 * Math.cos(phase));
		iq[2 * sample + 1] = Math.round(90 * Math.sin(phase));
	}
	return new Uint8Array(iq.buffer);
}
