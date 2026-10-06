import dspModule from '../hackrf-web/pkg/hackrf_web_bg.wasm';
import ft8Module from '../public/lib/ft8/decoder.wasm';
import recordingUrl from './fixtures/ft8/websdr_test1.wav?inline';
import createFT8 from '../public/lib/ft8/decoder.js';
import { afterEach, expect, it, vi } from 'vitest';
import { RationalResampler } from '../src/client/worker/dsp-pipeline';

vi.mock('/hackrf-web/pkg/hackrf_web.js', async () => {
	const dsp = await vi.importActual('../hackrf-web/pkg/hackrf_web.js');
	const wasm = dsp.initSync({ module: dspModule });
	return { ...dsp, default: async () => wasm };
});
afterEach(() => vi.unstubAllGlobals());

it('decodes recorded FT8 stations through the real USB DDC, audio resampling, and receive WASM', async () => {
	const recordingBytes = Uint8Array.from(atob(recordingUrl.split(',')[1]), character => character.charCodeAt(0)).buffer;
	const data = new DataView(recordingBytes);
	const recording = new Float32Array(180000);
	for (let pos = 12; pos + 8 < data.byteLength;) {
		const id = String.fromCharCode(...new Uint8Array(recordingBytes, pos, 4));
		const length = data.getUint32(pos + 4, true);
		if (id === 'data') for (let i = 0; i < Math.min(length / 2, recording.length); i++) recording[i] = data.getInt16(pos + 8 + i * 2, true) / 32768;
		pos += 8 + length + (length % 2);
	}
	const up = new RationalResampler(12000, 48000);
	const inputAudio = up.process(recording);
	const messages = [];
	vi.stubGlobal('self', { postMessage: message => messages.push(message) });
	await import('../src/client/dsp-worker');
	const params = { freq: 7.01, mode: 'usb', bandwidth: 3000, enabled: false, ft8: true, squelchEnabled: false };
	await self.onmessage({ data: { type: 'init', sampleRate: 48000, centerFreq: 7, params } });
	const blocks = [];
	for (let offset = 0; offset < inputAudio.length; offset += 4032) {
		const size = Math.min(4032, inputAudio.length - offset);
		const iq = new Float32Array(size * 2);
		for (let i = 0; i < size; i++) {
			const phase = 2 * Math.PI * 10000 * (offset + i) / 48000;
			iq[2 * i] = inputAudio[offset + i] * Math.cos(phase);
			iq[2 * i + 1] = inputAudio[offset + i] * Math.sin(phase);
		}
		await self.onmessage({ data: { type: 'process', sampleRate: 48000, centerFreq: 7, floatIq: true, params, chunkLen: iq.length, chunk: iq.buffer } });
		const message = messages.at(-1);
		expect(message.type).toBe('audio');
		if (message.samples) blocks.push(new Float32Array(message.samples));
	}
	const audio = new Float32Array(blocks.reduce((sum, block) => sum + block.length, 0));
	let offset = 0;
	for (const block of blocks) { audio.set(block, offset); offset += block.length; }
	const down = new RationalResampler(48000, 12000);
	const frame = new Float32Array(180000);
	frame.set(down.process(audio).subarray(0, frame.length));
	const decoder = await createFT8({ instantiateWasm(imports, receive) {
		const instance = new WebAssembly.Instance(ft8Module, imports);
		receive(instance, ft8Module);
		return instance.exports;
	} });
	decoder._ft8_init();
	const ptr = decoder._malloc(frame.byteLength);
	decoder.HEAPF32.set(frame, ptr / 4);
	const count = decoder._ft8_decode(ptr, frame.length);
	const result = decoder._ft8_results();
	const texts = Array.from({ length: count }, (_, i) => {
		const bytes = decoder.HEAPU8.subarray(result + i * 52 + 12, result + i * 52 + 52);
		return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
	});
	decoder._free(ptr);
	expect(texts).toContain('CQ IK4LZH JN54');
	expect(texts.length).toBeGreaterThanOrEqual(8);
}, 15000);
