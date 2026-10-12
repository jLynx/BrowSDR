import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirspyIqConverter } from '@/devices/airspy/iq-converter';

const binary = readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
afterEach(() => vi.unstubAllGlobals());

function magnitude(samples, frequency) {
	const count = 4800;
	let real = 0,
		imaginary = 0;
	for (let n = 0; n < count; n++) {
		const sample = samples[samples.length - count + n];
		const phase = (2 * Math.PI * frequency * n) / 48000;
		real += sample * Math.cos(phase);
		imaginary += sample * Math.sin(phase);
	}
	return (2 * Math.hypot(real, imaginary)) / count;
}

describe('Airspy ADC through production WFM DSP', () => {
	it.each([2500000, 10000000])('recovers audio from high-side IF at %i IQ samples/s', async (sampleRate) => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 95.1, mode: 'wfm', bandwidth: 200000, enabled: true, stereo: false, squelchEnabled: false, deEmphasis: 'none' };
		const send = (data) => self.onmessage({ data });
		await send({ type: 'init', sampleRate, centerFreq: 95, params });
		const converter = new AirspyIqConverter();
		const adcRate = sampleRate * 2;
		const blocks = [];
		let phase = 0;
		let position = 0;
		const sizes = [131072, 65535, 8193];
		let block = 0;
		while (position < adcRate * 0.25) {
			const count = Math.min(sizes[block++ % sizes.length], adcRate * 0.25 - position);
			const raw = new DataView(new ArrayBuffer(count * 2));
			for (let n = 0; n < count; n++) {
				const audio = 0.4 * Math.sin((2 * Math.PI * 1000 * (position + n)) / adcRate);
				// High-side R820T LO inverts RF offsets and FM deviation at the ADC.
				phase += (2 * Math.PI * (adcRate / 4 - 100000 - 75000 * audio)) / adcRate;
				raw.setUint16(n * 2, Math.round(2048 + 1400 * Math.cos(phase)), true);
			}
			const iq = converter.process(raw);
			await send({ type: 'process', params, sampleRate, centerFreq: 95, chunk: iq.buffer, chunkLen: iq.length });
			const result = messages.at(-1);
			expect(result.type).toBe('audio');
			if (result.samples) blocks.push(new Float32Array(result.samples));
			position += count;
		}
		const output = Float32Array.from(blocks.flatMap((samples) => [...samples]));
		expect(output.length).toBeGreaterThan(10000);
		expect(output.every(Number.isFinite)).toBe(true);
		const wanted = magnitude(output, 1000);
		expect(wanted).toBeGreaterThan(0.2);
		expect(magnitude(output, 2300) / wanted).toBeLessThan(0.02);
	});
});
