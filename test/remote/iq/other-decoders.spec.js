import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Rtl433Module from '../../../wasm/rtl433/pkg/rtl433.js';
import { remoteDecode } from './worker-fixture';
import { makeMpx, stationBits, wavemanIq } from './radio-fixtures';

const binary = readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
const rtlBinary = readFileSync(new URL('../../../wasm/rtl433/pkg/rtl433.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
vi.mock('/wasm/rtl433/rtl433.js', () => ({ default: (options) => Rtl433Module({ ...options, wasmBinary: rtlBinary }) }));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('additional real decoders on remote IQ', () => {
	it.each([8, 16])(
		'recovers RDS station and RadioText with %s-bit IQ',
		async (bits) => {
			const mpx = makeMpx(Array.from({ length: 5 }, stationBits).flat(), 1e6);
			const input = new Float32Array(mpx.length * 2);
			let phase = 0;
			for (let i = 0; i < mpx.length; i++) {
				phase += (2 * Math.PI * (100000 + 75000 * mpx[i])) / 1e6;
				input[2 * i] = 0.7 * Math.cos(phase);
				input[2 * i + 1] = 0.7 * Math.sin(phase);
			}
			const params = { freq: 100.1, mode: 'wfm', bandwidth: 150000, enabled: false, rds: true };
			const { messages } = await remoteDecode(input, params, bits, 1e6, 100);
			expect(messages.filter((m) => m.type === 'rds').map((m) => m.msg)).toContainEqual(expect.objectContaining({ ps: 'channelX' }));
			expect(messages.filter((m) => m.type === 'rds').map((m) => m.msg)).toContainEqual(
				expect.objectContaining({ rt: 'Madness - Our House' }),
			);
		},
		30000,
	);
	it.each([8, 16])('recovers an rtl_433 sensor payload with %s-bit IQ', async (bits) => {
		const params = { freq: 433.92, mode: 'nfm', bandwidth: 12500, enabled: false, rtl433: true, rtl433SampleRate: 250000 };
		const { messages } = await remoteDecode(wavemanIq(1e6, -100000), params, bits);
		expect(messages.filter((m) => m.type === 'rtl433_event').map((m) => m.event)).toContainEqual(
			expect.objectContaining({ model: 'Waveman-Switch', id: 'D', state: 'ON' }),
		);
	});
});
