import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const binary = readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const frame = Uint8Array.from('8D40621D58C382D690C8AC2863A7'.match(/../g), (byte) => parseInt(byte, 16));
function signal(float) {
	const input = float ? new Float32Array(2000) : new Int8Array(2000);
	const high = new Set([0, 2, 7, 9]);
	for (let bit = 0; bit < 112; bit++) high.add(16 + bit * 2 + ((frame[bit >> 3] >> (7 - (bit & 7))) & 1 ? 0 : 1));
	for (const sample of high) input[(sample + 100) * 2] = float ? 0.7 : 90;
	return input;
}

describe('ADS-B through the actual DSP worker', () => {
	it.each([false, true])('decodes muted VFO input (float=%s), acknowledges buffers and stops after disabling', async (float) => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 1090, mode: 'nfm', bandwidth: 12500, enabled: false, adsb: true };
		const send = (data) => self.onmessage({ data });
		await send({ type: 'init', sampleRate: 2000000, centerFreq: 1090, params });
		vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
		const input = signal(float);
		await send({ type: 'process', params, chunk: input.buffer, chunkLen: input.length, floatIq: float, chunkId: 1 });
		expect(messages.find((message) => message.type === 'adsb' && message.status.frames === 1)?.aircraft[0].icao).toBe('40621D');
		expect(messages.at(-1).chunkId).toBe(1);
		expect(messages.at(-1).type).toBe('audio');
		expect(messages.at(-1).samples).toBeNull();
		await send({ type: 'configure', centerFreq: 1090, params: { ...params, adsb: false } });
		expect(messages.findLast((message) => message.type === 'adsb').status.state).toBe('off');
	});
	it('discards a partial burst after an IQ delivery gap', async () => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 1090, mode: 'nfm', bandwidth: 12500, enabled: false, adsb: true };
		const send = (data) => self.onmessage({ data });
		await send({ type: 'init', sampleRate: 2000000, centerFreq: 1090, params });
		vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
		const input = signal(true);
		for (const [chunkId, chunk] of [
			[1, input.slice(0, 400)],
			[3, input.slice(400)],
		]) {
			await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: true, chunkId });
		}
		expect(messages.findLast((message) => message.type === 'adsb').status.frames).toBe(0);
	});
});
