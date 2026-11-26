import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IqSliceExtractor } from '@/remote/iq/extractor';
import { unpackIqPacket, MAX_IQ_VALUES } from '@/remote/iq/packet';
import { planIqSlice } from '@/remote/iq/plan';
import { frame, signal } from '../../decoders/radiosonde/fixtures';

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

async function receiver() {
	vi.resetModules();
	const messages = [];
	vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
	await import('@/worker/dsp-worker');
	return { messages, send: (data) => self.onmessage({ data }) };
}

const restored = (packet) => Float32Array.from(packet.samples, (value) => value * packet.scale);

describe('IQ extraction with the production WASM', () => {
	it.each([8, 16])('isolates an offset channel and preserves RF amplitude with %s-bit quantization', async (bits) => {
		const dsp = await import('/wasm/dsp/browsdr_dsp.js');
		const wasm = await dsp.default();
		const extractor = new IqSliceExtractor(dsp.DspProcessor, wasm.memory);
		const ptr = dsp.alloc_float_buffer(262144);
		try {
			const input = new Float32Array(wasm.memory.buffer, ptr, 262144);
			for (let i = 0; i < input.length / 2; i++) {
				const wanted = (2 * Math.PI * 103000 * i) / 2e6;
				const unwanted = (2 * Math.PI * 205000 * i) / 2e6;
				input[2 * i] = 0.2 * Math.cos(wanted) + 0.6 * Math.cos(unwanted);
				input[2 * i + 1] = 0.2 * Math.sin(wanted) + 0.6 * Math.sin(unwanted);
			}
			const slice = { centerFreq: 100.1, sampleRate: 50000, bandwidth: 12500, index: 0, revision: 1, bits, fullBand: false };
			const packets = extractor.process(slice, 2e6, 100, ptr, input.length, true, 1).map(unpackIqPacket);
			expect(packets[0].discontinuity).toBe(true);
			expect(packets.every((p) => p.samples.length <= MAX_IQ_VALUES)).toBe(true);
			const iq = new Float32Array(packets.flatMap((p) => [...restored(p)]));
			expect(iq.length / 2).toBeCloseTo(131072 / 40, -1);
			const magnitude = (frequency) => {
				let re = 0,
					im = 0,
					count = 0;
				for (let i = 1000; i < iq.length / 2; i++) {
					const phase = (2 * Math.PI * frequency * i) / slice.sampleRate;
					re += iq[2 * i] * Math.cos(phase) + iq[2 * i + 1] * Math.sin(phase);
					im += iq[2 * i + 1] * Math.cos(phase) - iq[2 * i] * Math.sin(phase);
					count++;
				}
				return Math.hypot(re, im) / count;
			};
			expect(magnitude(3000)).toBeCloseTo(0.2, 2);
			expect(magnitude(5000)).toBeLessThan(0.003);
			expect(extractor.process(slice, 2e6, 100, ptr, input.length, true, 2).map(unpackIqPacket)[0].discontinuity).toBe(false);
			expect(extractor.process(slice, 2e6, 100, ptr, input.length, true, 4).map(unpackIqPacket)[0].discontinuity).toBe(true);
		} finally {
			extractor.reset();
		}
	});
	it('forwards a full capture without filtering or losing DC and marks retunes', async () => {
		const dsp = await import('/wasm/dsp/browsdr_dsp.js');
		const wasm = await dsp.default();
		const extractor = new IqSliceExtractor(dsp.DspProcessor, wasm.memory);
		const ptr = dsp.alloc_float_buffer(12000);
		try {
			new Float32Array(wasm.memory.buffer, ptr, 12000).fill(0.25);
			const slice = { centerFreq: 100, sampleRate: 20e6, bandwidth: 20e6, index: 0, revision: 1, bits: 16, fullBand: true };
			const packets = extractor.process(slice, 20e6, 100, ptr, 12000, true, 1).map(unpackIqPacket);
			expect(packets).toHaveLength(2);
			expect(packets[0].fullBand).toBe(true);
			expect([...restored(packets[1])].every((value) => Math.abs(value - 0.25) < 1e-6)).toBe(true);
			expect(extractor.process({ ...slice, revision: 2 }, 20e6, 100, ptr, 12000, true, 2).map(unpackIqPacket)[0].discontinuity).toBe(true);
		} finally {
			extractor.reset();
		}
	});
	it.each([
		['int8', 8],
		['int8', 16],
		['int16', 8],
		['int16', 16],
	])('decodes RS41 on the client after %s capture and %s-bit remote slices', async (iqFormat, bits) => {
		const rx = await receiver();
		const params = { freq: 403, mode: 'nfm', bandwidth: 2000, enabled: false, radiosonde: true, squelchEnabled: false };
		const slice = { ...planIqSlice(params, 1e6, 403.1), index: 0, revision: 9, bits };
		const input = signal(frame(), 1e6, -100000);
		await rx.send({ type: 'init', extractOnly: true, sampleRate: 1e6, centerFreq: 403.1, params });
		for (let offset = 0, chunkId = 0; offset < input.length; offset += 262144, chunkId++) {
			const part = input.subarray(offset, offset + 262144);
			const values =
				iqFormat === 'int8'
					? Int8Array.from(part, (value) => Math.round(value * 127))
					: Int16Array.from(part, (value) => Math.round(value * 32767));
			await rx.send({
				type: 'process',
				slice,
				params,
				sampleRate: 1e6,
				centerFreq: 403.1,
				iqFormat,
				chunkId,
				chunkLen: values.length,
				chunk: values.buffer,
			});
		}
		expect(rx.messages.some((m) => m.type === 'audio' || m.type === 'radiosonde')).toBe(false);
		const packets = rx.messages
			.filter((m) => m.type === 'iq_slice')
			.flatMap((m) => m.packets)
			.map(unpackIqPacket);
		expect(packets.length).toBeGreaterThan(10);
		rx.messages.length = 0;
		await rx.send({ type: 'init', sampleRate: 1e6, centerFreq: 403.1, params });
		let time = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (time += 1000));
		for (const packet of packets) {
			const samples = restored(packet);
			await rx.send({
				type: 'process',
				params,
				sampleRate: packet.sampleRate,
				centerFreq: packet.centerFreq,
				floatIq: true,
				discontinuity: packet.discontinuity,
				sequence: packet.sequence,
				chunkId: packet.sequence,
				chunkLen: samples.length,
				chunk: samples.buffer,
			});
		}
		expect(rx.messages.find((m) => m.type === 'radiosonde' && m.status.frames > 0)?.sondes[0]).toMatchObject({ id: 'V1234567' });
		expect(rx.messages.filter((m) => m.type === 'error')).toEqual([]);
	});
});
