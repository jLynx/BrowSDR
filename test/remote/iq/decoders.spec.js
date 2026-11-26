import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { positionReport, radioSignal as aisSignal } from '../../decoders/ais/fixtures';
import { payload, radioSignal as acarsSignal } from '../../decoders/acars/fixtures';
import { packetSignal } from '../../decoders/aprs/fixtures';
import { advertisement, radioSignal as bleSignal } from '../../decoders/ble/fixtures';
import { remoteDecode } from './worker-fixture';

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

describe('client protocol decoding through quantized remote IQ slices', () => {
	it.each([8, 16])('recovers AIS position reports with %s-bit IQ', async (bits) => {
		const params = { freq: 161.975, mode: 'nfm', bandwidth: 12500, enabled: false, ais: true };
		const { messages } = await remoteDecode(aisSignal(positionReport(), 1e6, -100000), params, bits);
		expect(messages.flatMap((m) => m.vessels ?? [])).toContainEqual(expect.objectContaining({ mmsi: '512123456' }));
	});
	it.each([8, 16])('recovers ACARS text with %s-bit IQ', async (bits) => {
		const params = { freq: 131.55, mode: 'am', bandwidth: 8000, enabled: false, acars: true };
		const { messages } = await remoteDecode(acarsSignal(payload(), 2e6, -50000), params, bits, 2e6, 131.6);
		expect(messages.flatMap((m) => m.messages ?? [])).toContainEqual(
			expect.objectContaining({ text: expect.stringContaining('ARRIVAL GATE 12') }),
		);
	});
	it.each([8, 16])('recovers APRS packets with %s-bit IQ', async (bits) => {
		const params = { freq: 144.39, mode: 'nfm', bandwidth: 12500, enabled: false, aprs: true };
		const input = packetSignal('N0CALL-9', 'APRS', ['WIDE1-1'], '!4903.50N/07201.75W>088/036Hello', { rate: 1e6, offset: -100000 });
		const { messages } = await remoteDecode(input, params, bits);
		expect(messages.flatMap((m) => m.packets ?? [])).toContainEqual(expect.objectContaining({ source: 'N0CALL-9' }));
	});
	it.each([8, 16])('recovers BLE advertisements with %s-bit IQ', async (bits) => {
		const params = { freq: 2426, mode: 'raw', bandwidth: 48000, enabled: false, ble: true };
		const { messages } = await remoteDecode(bleSignal(advertisement(), 38, 8e6, 1e6), params, bits, 8e6, 2425);
		expect(messages.flatMap((m) => m.advertisements ?? [])).toContainEqual(expect.objectContaining({ name: 'TEST', channel: 38 }));
	});
	it.each([8, 16])('recovers ADS-B PPM with %s-bit IQ', async (bits) => {
		const frame = Uint8Array.from('8D40621D58C382D690C8AC2863A7'.match(/../g), (byte) => parseInt(byte, 16));
		const input = new Float32Array(2000);
		const high = new Set([0, 2, 7, 9]);
		for (let bit = 0; bit < 112; bit++) high.add(16 + bit * 2 + ((frame[bit >> 3] >> (7 - (bit & 7))) & 1 ? 0 : 1));
		for (const sample of high) input[(sample + 100) * 2] = 0.7;
		const params = { freq: 1090, mode: 'nfm', bandwidth: 12500, enabled: false, adsb: true };
		const { messages } = await remoteDecode(input, params, bits, 2e6, 1090);
		expect(messages.flatMap((m) => m.aircraft ?? [])).toContainEqual(expect.objectContaining({ icao: '40621D' }));
	});
});
