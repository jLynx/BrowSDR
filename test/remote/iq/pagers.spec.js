import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _POCSAGSingleBaud } from '@/worker/decoders/pocsag';
import { decodeLocalPager } from '@/worker/streams/local-audio';
import { messageWords, transmission, render } from '../../decoders/flex/fixtures';
import { remoteDecode } from './worker-fixture';
import { encodeBatch } from './pager-fixtures';

const binary = readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function codeword(payload) {
	const decoder = new _POCSAGSingleBaud(48000, 1200, () => {});
	for (let ecc = 0; ecc < 1024; ecc++) {
		let cw = ((payload << 11) | (ecc << 1)) >>> 0;
		if (decoder._popcount32(cw) & 1) cw = (cw | 1) >>> 0;
		const result = decoder._eccCorrect(cw);
		if (result.errors === 0 && result.cw === cw) return cw;
	}
	throw new Error('Invalid synthetic codeword');
}
function pocsagBits() {
	const alpha = [...'HELLO'].flatMap((c) => Array.from({ length: 7 }, (_, i) => (c.charCodeAt(0) >> i) & 1));
	while (alpha.length % 20) alpha.push(0);
	const words = [codeword(0x155 << 2)];
	for (let i = 0; i < alpha.length; i += 20) {
		let value = 0;
		for (const bit of alpha.slice(i, i + 20)) value = (value << 1) | bit;
		words.push(codeword((1 << 20) | value));
	}
	while (words.length < 16) words.push(_POCSAGSingleBaud.IDLE_CW);
	return [
		...Array.from({ length: 576 }, (_, i) => i & 1),
		...[_POCSAGSingleBaud.SYNC_WORD, ...words].flatMap((w) => Array.from({ length: 32 }, (_, i) => (w >>> (31 - i)) & 1)),
		...Array(128).fill(0),
	];
}
const levels = (bits, baud) => Float32Array.from(bits.flatMap((bit) => Array(48000 / baud).fill(bit ? -0.5 : 0.5)));
function fm(audio) {
	const rate = 1e6,
		iq = new Float32Array(Math.ceil((audio.length * rate) / 48000) * 2);
	let phase = 0;
	for (let i = 0; i < iq.length / 2; i++) {
		phase += (2 * Math.PI * (100000 + 4500 * audio[Math.min(audio.length - 1, Math.floor((i * 48000) / rate))])) / rate;
		iq[2 * i] = 0.7 * Math.cos(phase);
		iq[2 * i + 1] = 0.7 * Math.sin(phase);
	}
	return iq;
}
describe('paging messages decoded by the remote client backend', () => {
	it.each(['pocsag', 'gsc', 'flex'].flatMap((protocol) => [8, 16].map((bits) => [protocol, bits])))(
		'%s recovers message text from %s-bit IQ',
		async (protocol, bits) => {
			const audio =
				protocol === 'pocsag'
					? levels(pocsagBits(), 1200)
					: protocol === 'gsc'
						? levels([...encodeBatch(0, 2, 0, 'HELLO', true), ...Array(64).fill(0)], 600)
						: render(transmission('A1', messageWords('HELLO')));
			const params = { freq: 157.95, mode: 'nfm', bandwidth: 2000, enabled: false, [protocol]: true };
			const { messages } = await remoteDecode(fm(audio), params, bits, 1e6, 157.85);
			const pages = [],
				state = {};
			const callbacks = { [protocol]: (_index, _freq, page) => pages.push(page) };
			for (const message of messages)
				if (message.type === 'audio' && message.samples)
					decodeLocalPager(callbacks, params, state, 0, new Float32Array(message.samples), message.pager);
			expect(pages).toContainEqual(expect.objectContaining({ text: expect.stringContaining('HELLO') }));
			expect(messages.filter((m) => m.pager && m.pager !== protocol)).toEqual([]);
		},
	);
});
