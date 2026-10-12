import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { positionReport, radioSignal } from './fixtures';

const binary = readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AIS through the production DSP worker', () => {
	it.each([false, true])('channelizes and decodes muted VFO input before acknowledging buffers (float=%s)', async (float) => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 161.975, mode: 'nfm', bandwidth: 12500, enabled: false, ais: true };
		const send = (data) => self.onmessage({ data });
		await send({ type: 'init', sampleRate: 2000000, centerFreq: 162, params });
		const signal = radioSignal(positionReport(), 2000000, -25000);
		const input = float ? signal : Int8Array.from(signal, (value) => Math.round(value * 127));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		let chunkId = 0;
		for (let i = 0; i < input.length; i += 65536) {
			const chunk = input.slice(i, i + 65536);
			await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: float, chunkId: ++chunkId });
		}
		expect(messages.find((message) => message.type === 'ais' && message.status.frames === 1)?.vessels[0]).toMatchObject({
			mmsi: '512123456',
			latitude: -36.84,
		});
		expect(messages.at(-1)).toMatchObject({ type: 'audio', samples: null, chunkId });
		await send({ type: 'configure', centerFreq: 162, params: { ...params, ais: false } });
		expect(messages.findLast((message) => message.type === 'ais').status.state).toBe('off');
	});
	it('rejects partial radio frames after an IQ delivery gap', async () => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 162.025, mode: 'nfm', bandwidth: 12500, enabled: false, ais: true };
		const send = (data) => self.onmessage({ data });
		await send({ type: 'init', sampleRate: 48000, centerFreq: params.freq, params });
		const signal = radioSignal(positionReport());
		for (const [chunkId, chunk] of [
			[1, signal.slice(0, 1000)],
			[3, signal.slice(1000)],
		])
			await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: true, chunkId });
		expect(messages.filter((message) => message.type === 'ais').every((message) => message.status.frames === 0)).toBe(true);
	});
});
