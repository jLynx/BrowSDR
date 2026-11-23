import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRFilter, rrcTaps } from '@/worker/decoders/dsd/dsd-dsp';
import { SYNC_WORDS, RRC_NUM_TAPS, RRC_ALPHA } from '@/worker/decoders/dsd/constants';
import { remoteDecode } from './worker-fixture';

const binary = readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
// This fixture contains data syncs, not encoded speech. Vocoder reception is separate.
vi.mock('@/worker/decoders/mbelib-init', () => ({
	ensureMbelibInitialized: async () => {},
	decodeAmbe: () => new Float32Array(160),
	decodeImbe: () => new Float32Array(160),
	resetMbe: () => {},
	getMbeErrors: () => 0,
}));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('DSD acquisition through remote IQ', () => {
	it.each([8, 16])('acquires DMR data bursts after %s-bit transport', async (bits) => {
		let seed = 123456789;
		const dibits = Uint8Array.from({ length: 144 * 30 }, () => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return seed & 3;
		});
		for (let burst = 0; burst < 30; burst++) dibits.set(Uint8Array.from(SYNC_WORDS.DMR_BS_DATA, Number), burst * 144 + 66);
		const impulses = new Float32Array(dibits.length * 10 + 100),
			audio = new Float32Array(impulses.length);
		for (let i = 0; i < dibits.length; i++) impulses[10 * i] = [1, 3, -1, -3][dibits[i]] * 0.25;
		new FIRFilter(rrcTaps(RRC_NUM_TAPS, 48000, 4800, RRC_ALPHA)).process(impulses, audio);
		const input = new Float32Array(Math.ceil((audio.length * 1e6) / 48000) * 2);
		let phase = 0;
		for (let i = 0; i < input.length / 2; i++) {
			phase += (2 * Math.PI * (100000 + 16000 * audio[Math.min(audio.length - 1, Math.floor((i * 48000) / 1e6))])) / 1e6;
			input[2 * i] = 0.7 * Math.cos(phase);
			input[2 * i + 1] = 0.7 * Math.sin(phase);
		}
		const { messages } = await remoteDecode(input, { freq: 439.7, mode: 'dsd', bandwidth: 12500, enabled: true }, bits, 1e6, 439.6);
		expect(messages.filter((m) => m.type === 'dsd_status').map((m) => m.status)).toContainEqual(
			expect.objectContaining({ mode: 'dmr', synced: true }),
		);
	});
});
