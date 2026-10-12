import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advertisement, radioSignal } from './fixtures';

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

describe('BLE production worker', () => {
	it.each([false, true])('decodes muted BLE from 8 MSPS off-center IQ (float=%s)', async (float) => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 2426, mode: 'raw', bandwidth: 48000, enabled: false, ble: true };
		const send = (data) => self.onmessage({ data });
		await send({ type: 'init', sampleRate: 8000000, centerFreq: 2425, params });
		const signal = radioSignal(advertisement(), 38, 8000000, 1000000);
		const input = float ? signal : Int8Array.from(signal, (value) => Math.round(value * 127));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		let chunkId = 0;
		for (let i = 0; i < input.length; i += 1024) {
			const chunk = input.slice(i, i + 1024);
			await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: float, chunkId: ++chunkId });
		}
		expect(messages.flatMap((message) => message.advertisements ?? [])).toEqual([expect.objectContaining({ name: 'TEST', channel: 38 })]);
		expect(messages.at(-1)).toMatchObject({ type: 'audio', samples: null, chunkId });
	});
	it('reports unsupported frequency and insufficient passband', async () => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 2402, mode: 'raw', bandwidth: 48000, enabled: false, ble: true };
		await self.onmessage({ data: { type: 'init', sampleRate: 1000000, centerFreq: 2402, params } });
		expect(messages.findLast((message) => message.type === 'ble').status.state).toBe('error');
		await self.onmessage({ data: { type: 'configure', centerFreq: 2402, params: { ...params, freq: 2404 } } });
		expect(messages.findLast((message) => message.type === 'ble').status.message).toContain('37');
	});
	it('rejects a packet interrupted by dropped IQ and recovers on the next complete advertisement', async () => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 2402, mode: 'raw', bandwidth: 48000, enabled: false, ble: true };
		await self.onmessage({ data: { type: 'init', sampleRate: 2000000, centerFreq: 2402, params } });
		const input = radioSignal();
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		for (const [chunkId, chunk] of [
			[1, input.slice(0, 400)],
			[3, input.slice(400)],
			[4, input],
		]) {
			await self.onmessage({ data: { type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: true, chunkId } });
		}
		expect(messages.flatMap((message) => message.advertisements ?? [])).toHaveLength(1);
		await self.onmessage({ data: { type: 'configure', centerFreq: 2402, params: { ...params, ble: false } } });
		expect(messages.findLast((message) => message.type === 'ble').status.state).toBe('off');
	});
});
