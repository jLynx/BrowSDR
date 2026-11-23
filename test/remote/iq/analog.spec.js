import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remoteDecode, audioSamples } from './worker-fixture';

const binary = readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function signal(mode, rate = 1e6) {
	const iq = new Float32Array(rate * 0.4 * 2);
	let phase = 0;
	for (let i = 0; i < iq.length / 2; i++) {
		const tone = Math.sin((2 * Math.PI * 1000 * i) / rate);
		const shift = mode === 'lsb' ? -1000 : mode === 'cw' ? 0 : 1000;
		const frequency = mode.endsWith('fm') ? (mode === 'wfm' ? 50000 : 2500) * tone : mode === 'am' || mode === 'dsb' ? 0 : shift;
		phase += (2 * Math.PI * (100000 + frequency)) / rate;
		const amplitude = mode === 'am' ? 0.4 * (1 + 0.5 * tone) : mode === 'dsb' ? 0.4 * tone : 0.4;
		iq[2 * i] = amplitude * Math.cos(phase);
		iq[2 * i + 1] = amplitude * Math.sin(phase);
	}
	return iq;
}
function toneAmplitude(audio, hz) {
	const tail = audio.subarray(-4800);
	let re = 0,
		im = 0;
	for (let i = 0; i < tail.length; i++) {
		const phase = (2 * Math.PI * hz * i) / 48000;
		re += tail[i] * Math.cos(phase);
		im += tail[i] * Math.sin(phase);
	}
	return (2 * Math.hypot(re, im)) / tail.length;
}
describe('analogue demodulation on the remote client', () => {
	it.each(['am', 'nfm', 'wfm', 'usb', 'lsb', 'dsb', 'cw', 'raw'].flatMap((mode) => [8, 16].map((bits) => [mode, bits])))(
		'%s retains audio pitch after %s-bit transport',
		async (mode, bits) => {
			const bandwidth = mode === 'wfm' ? 150000 : mode === 'cw' ? 1000 : 12500;
			const params = {
				freq: 100.1,
				mode,
				bandwidth,
				enabled: true,
				squelchEnabled: false,
				lowPass: false,
				highPass: false,
				deEmphasis: 'none',
			};
			const { messages } = await remoteDecode(signal(mode), params, bits, 1e6, 100);
			const audio = audioSamples(messages);
			expect(audio.length).toBeGreaterThan(18000);
			expect(audio.every(Number.isFinite)).toBe(true);
			const wanted = mode === 'cw' ? 700 : 1000;
			expect(toneAmplitude(audio, wanted)).toBeGreaterThan(0.05);
			expect(toneAmplitude(audio, wanted + 300)).toBeLessThan(toneAmplitude(audio, wanted) * 0.05);
		},
	);
});
