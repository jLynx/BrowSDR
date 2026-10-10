import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { payload, radioSignal } from './fixtures';

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

describe('ACARS through the production DSP worker', () => {
	it.each([false, true])('channelizes and decodes muted VFO input before acknowledging buffers (float=%s)', async (float) => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 131.55, mode: 'nfm', bandwidth: 12500, enabled: false, acars: true };
		const send = (data) => self.onmessage({ data });
		await send({ type: 'init', sampleRate: 2000000, centerFreq: 131.6, params });
		const signal = radioSignal(payload(), 2000000, -50000);
		const input = float ? signal : Int8Array.from(signal, (value) => Math.round(value * 127));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		let chunkId = 0;
		for (let i = 0; i < input.length; i += 65536) {
			const chunk = input.slice(i, i + 65536);
			await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: float, chunkId: ++chunkId });
		}
		expect(messages.find((message) => message.type === 'acars' && message.status.frames === 1)?.messages[0]).toMatchObject({
			registration: 'ZK-NZE',
			flight: 'ANZ001',
		});
		expect(messages.at(-1)).toMatchObject({ type: 'audio', samples: null, chunkId });
		await send({ type: 'configure', centerFreq: 131.6, params: { ...params, acars: false } });
		expect(messages.findLast((message) => message.type === 'acars').status.state).toBe('off');
	});
	it('rejects partial radio frames after an IQ delivery gap', async () => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 131.725, mode: 'nfm', bandwidth: 12500, enabled: false, acars: true };
		const send = (data) => self.onmessage({ data });
		await send({ type: 'init', sampleRate: 48000, centerFreq: params.freq, params });
		const signal = radioSignal(payload());
		for (const [chunkId, chunk] of [
			[1, signal.slice(0, 1000)],
			[3, signal.slice(1000)],
		])
			await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: true, chunkId });
		expect(messages.filter((message) => message.type === 'acars').every((message) => message.status.frames === 0)).toBe(true);
	});
});
