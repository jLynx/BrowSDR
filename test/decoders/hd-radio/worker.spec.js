import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Nrsc5Module from '../../../wasm/nrsc5/pkg/nrsc5.js';

const binary = readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
const nrsc5Binary = readFileSync(new URL('../../../wasm/nrsc5/pkg/nrsc5.wasm', import.meta.url));
vi.mock('/wasm/nrsc5/nrsc5.js', () => ({ default: (options) => Nrsc5Module({ ...options, wasmBinary: nrsc5Binary }) }));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('HD Radio in the production worker', () => {
	it.each(['int8', 'int16', 'float32'])('keeps unlocked %s IQ silent and restores analog audio after changing modes', async (format) => {
		vi.resetModules();
		const messages = [];
		vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
		await import('@/worker/dsp-worker');
		const params = { freq: 105.3, mode: 'hdradio', bandwidth: 400000, enabled: true };
		const send = (data) => self.onmessage({ data });
		await send({ type: 'init', sampleRate: 1000000, centerFreq: 105.3, params });
		expect(messages.at(-1)).toMatchObject({ type: 'init_done' });
		expect(messages.findLast((message) => message.type === 'hd_radio').status.state).toBe('searching');
		const chunk = format === 'int16' ? new Int16Array(65536) : format === 'float32' ? new Float32Array(65536) : new Int8Array(65536);
		await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, iqFormat: format, chunkId: 1 });
		expect(messages.at(-1)).toMatchObject({ type: 'audio', samples: null, squelchOpen: false });
		const analog = { ...params, mode: 'wfm', bandwidth: 150000, deEmphasis: 'none' };
		await send({ type: 'configure', centerFreq: 105.3, params: analog });
		await send({ type: 'process', params: analog, chunk: chunk.buffer, chunkLen: chunk.length, iqFormat: format, chunkId: 2 });
		expect(messages.at(-1).samples.byteLength).toBeGreaterThan(0);
		expect(messages.findLast((message) => message.type === 'hd_radio').status.state).toBe('off');
	});
});
