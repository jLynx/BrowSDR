import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packetSignal } from './fixtures';

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

async function startWorker(params, sampleRate, centerFreq) {
	vi.resetModules();
	const messages = [];
	vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
	await import('@/worker/dsp-worker');
	const send = (data) => self.onmessage({ data });
	await send({ type: 'init', sampleRate, centerFreq, params });
	let clock = performance.now();
	vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
	return { messages, send };
}

const INFO = '!4903.50N/07201.75W>088/036Hello';

describe('APRS through the production DSP worker', () => {
	it.each([false, true])('channelizes and decodes a muted VFO before acknowledging buffers (float=%s)', async (float) => {
		const params = { freq: 144.39, mode: 'nfm', bandwidth: 12500, enabled: false, aprs: true };
		const { messages, send } = await startWorker(params, 2000000, 144.4);
		const signal = packetSignal('N0CALL-9', 'APRS', ['WIDE1-1'], INFO, { rate: 2000000, offset: -10000, noise: 0.2 });
		const input = float ? signal : Int8Array.from(signal, (value) => Math.round(value * 127));
		let chunkId = 0;
		for (let i = 0; i < input.length; i += 65536) {
			const chunk = input.slice(i, i + 65536);
			await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: float, chunkId: ++chunkId });
		}
		const decoded = messages.findLast((message) => message.type === 'aprs');
		expect(decoded.status).toMatchObject({ state: 'receiving', frames: 1 });
		expect(decoded.packets[0]).toMatchObject({ source: 'N0CALL-9', path: ['WIDE1-1'], kind: 'position', comment: 'Hello', course: 88 });
		expect(decoded.stations[0]).toMatchObject({ id: 'N0CALL-9', symbol: '/>' });
		expect(messages.at(-1)).toMatchObject({ type: 'audio', samples: null, chunkId });
		await send({ type: 'configure', centerFreq: 144.4, params: { ...params, aprs: false } });
		expect(messages.findLast((message) => message.type === 'aprs').status.state).toBe('off');
	});
	it('rejects partial frames after an IQ delivery gap and reports unsupported frequencies', async () => {
		const params = { freq: 144.8, mode: 'nfm', bandwidth: 12500, enabled: false, aprs: true };
		const { messages, send } = await startWorker(params, 48000, params.freq);
		const signal = packetSignal('N0CALL', 'APRS', [], INFO);
		// 20 ms lead and 32 flags end near IQ value 22400; split inside the frame.
		for (const [chunkId, chunk] of [
			[1, signal.slice(0, 40000)],
			[3, signal.slice(40000)],
		])
			await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: true, chunkId });
		expect(messages.filter((message) => message.type === 'aprs').every((message) => message.status.frames === 0)).toBe(true);
		// The same chunks without a sequence gap decode.
		for (const [chunkId, chunk] of [
			[4, signal.slice(0, 40000)],
			[5, signal.slice(40000)],
		])
			await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: true, chunkId });
		expect(messages.findLast((message) => message.type === 'aprs').status.frames).toBe(1);
		await send({ type: 'configure', centerFreq: 100, params: { ...params, freq: 100 } });
		expect(messages.findLast((message) => message.type === 'aprs').status).toMatchObject({ state: 'error' });
	});
});
