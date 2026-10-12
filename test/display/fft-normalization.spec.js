import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { FFT, initSync, alloc_iq_buffer, free_iq_buffer } from '/wasm/dsp/browsdr_dsp.js';

let wasm;
beforeAll(() => {
	wasm = initSync({ module: readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url)) });
});

describe('committed browser FFT normalization', () => {
	it.each([8, 1024, 65536])('reports a half-amplitude DC tone as -6.02 dB with N=%i in both APIs', (n) => {
		const fft = new FFT(n, new Float32Array(n).fill(1));
		const input = new Int8Array(n * 2);
		for (let i = 0; i < n; i++) input[i * 2] = 64;
		const pointer = alloc_iq_buffer(input.length);
		try {
			const result = new Float32Array(n);
			fft.fft(input, result);
			new Int8Array(wasm.memory.buffer, pointer, input.length).set(input);
			const outputPointer = fft.fft_ptr(pointer, input.length);
			const pointed = new Float32Array(wasm.memory.buffer, outputPointer, n);
			for (const spectrum of [result, pointed]) {
				expect(spectrum.every(Number.isFinite)).toBe(true);
				expect(spectrum[n / 2]).toBeCloseTo(20 * Math.log10(0.5), 3);
				expect(Math.max(...spectrum)).toBe(spectrum[n / 2]);
			}
			expect(Array.from(pointed)).toEqual(Array.from(result));
		} finally {
			free_iq_buffer(pointer, input.length);
			fft.free();
		}
	});
});
