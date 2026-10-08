import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dspModule = readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: dspModule });
	return { ...dsp, default: async () => wasm };
});
afterEach(() => vi.unstubAllGlobals());

async function receiver() {
	vi.resetModules();
	const messages = [];
	vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
	await import('@/worker/dsp-worker');
	const params = { freq: 95.05, mode: 'wfm', bandwidth: 150000, enabled: true, stereo: true, deEmphasis: 'none', squelchEnabled: false };
	const send = (data) => self.onmessage({ data });
	await send({ type: 'init', sampleRate: 500000, centerFreq: 95, params });
	return { params, messages, send };
}

async function receive(rx, floatIq, pilot = true, sizes = [8192, 997, 16384]) {
	const rate = 500000;
	const blocks = [];
	let phase = 0;
	let offset = 0;
	let block = 0;
	while (offset < rate * 0.55) {
		const count = Math.min(sizes[block++ % sizes.length], rate * 0.55 - offset);
		const input = floatIq ? new Float32Array(count * 2) : new Int8Array(count * 2);
		for (let i = 0; i < count; i++) {
			const time = (offset + i) / rate;
			const left = 0.2 * Math.sin(2 * Math.PI * 1000 * time);
			const right = 0.2 * Math.sin(2 * Math.PI * 2300 * time);
			const mpx =
				(left + right) / 2 +
				((left - right) / 2) * Math.cos(2 * Math.PI * 38000 * time + 0.74) +
				(pilot ? 0.1 * Math.sin(2 * Math.PI * 19000 * time + 0.37) : 0);
			phase += (2 * Math.PI * (50000 + 75000 * mpx)) / rate;
			input[2 * i] = floatIq ? 0.7 * Math.cos(phase) : Math.round(89 * Math.cos(phase));
			input[2 * i + 1] = floatIq ? 0.7 * Math.sin(phase) : Math.round(89 * Math.sin(phase));
		}
		await rx.send({
			type: 'process',
			params: rx.params,
			floatIq,
			sampleRate: rate,
			centerFreq: 95,
			chunkLen: input.length,
			chunk: input.buffer,
		});
		const output = rx.messages.at(-1);
		expect(output.type).toBe('audio');
		expect(output.channels).toBe(rx.params.stereo ? 2 : 1);
		if (output.samples) blocks.push(new Float32Array(output.samples));
		offset += count;
	}
	return Float32Array.from(blocks.flatMap((block) => [...block]));
}

function amplitude(samples, channels, channel, frequency) {
	const start = samples.length - 4800 * channels;
	let real = 0,
		imag = 0;
	for (let i = 0; i < 4800; i++) {
		const phase = (2 * Math.PI * frequency * i) / 48000;
		const value = samples[start + i * channels + channel];
		real += value * Math.cos(phase);
		imag += value * Math.sin(phase);
	}
	return (2 * Math.hypot(real, imag)) / 4800;
}

describe('WFM stereo through the real WASM DSP worker', () => {
	it.each([false, true])('separates left and right using float IQ %s', async (floatIq) => {
		const audio = await receive(await receiver(), floatIq);
		expect(audio.length / 2).toBeGreaterThan(26000);
		expect(audio.every(Number.isFinite)).toBe(true);
		const left = amplitude(audio, 2, 0, 1000);
		const right = amplitude(audio, 2, 1, 2300);
		expect(left).toBeGreaterThan(0.15);
		expect(right).toBeGreaterThan(0.15);
		// At least 30 dB through the channel filter, FM discriminator and
		// resamplers; decoder-only separation is checked separately in Rust.
		expect(amplitude(audio, 2, 1, 1000) / left).toBeLessThan(0.032);
		expect(amplitude(audio, 2, 0, 2300) / right).toBeLessThan(0.032);
	});
	it('falls back to identical mono channels without a pilot', async () => {
		const audio = await receive(await receiver(), true, false);
		for (let i = audio.length - 9600; i < audio.length; i += 2) expect(audio[i]).toBeCloseTo(audio[i + 1], 5);
	});
	it('toggles stereo off and on and applies independent de-emphasis', async () => {
		const rx = await receiver();
		rx.params.stereo = false;
		await rx.send({ type: 'configure', centerFreq: 95, params: rx.params });
		const mono = await receive(rx, true);
		expect(amplitude(mono, 1, 0, 1000)).toBeGreaterThan(0.08);
		expect(amplitude(mono, 1, 0, 2300)).toBeGreaterThan(0.08);
		rx.params.stereo = true;
		rx.params.deEmphasis = '50us';
		await rx.send({ type: 'configure', centerFreq: 95, params: rx.params });
		const stereo = await receive(rx, true);
		expect(amplitude(stereo, 2, 0, 1000)).toBeGreaterThan(0.15);
		expect(amplitude(stereo, 2, 1, 2300)).toBeGreaterThan(0.13);
		expect(amplitude(stereo, 2, 1, 1000)).toBeLessThan(0.005);
		expect(amplitude(stereo, 2, 0, 2300)).toBeLessThan(0.005);
	});
	it('keeps channels synchronized after bandwidth and demodulation mode changes', async () => {
		const rx = await receiver();
		await receive(rx, true);
		rx.params.bandwidth = 180000;
		await rx.send({ type: 'configure', centerFreq: 95, params: rx.params });
		const wider = await receive(rx, true);
		expect(amplitude(wider, 2, 0, 1000)).toBeGreaterThan(0.12);
		expect(amplitude(wider, 2, 1, 1000)).toBeLessThan(0.006);
		await rx.send({ type: 'configure', centerFreq: 95, params: { ...rx.params, mode: 'nfm', bandwidth: 12500 } });
		await rx.send({ type: 'configure', centerFreq: 95, params: rx.params });
		const restored = await receive(rx, true);
		expect(amplitude(restored, 2, 1, 2300)).toBeGreaterThan(0.12);
		expect(amplitude(restored, 2, 0, 2300)).toBeLessThan(0.006);
	});
});
