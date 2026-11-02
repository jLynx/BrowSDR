import { readFileSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import Nrsc5Module from '../../../wasm/nrsc5/pkg/nrsc5.js';
import init, { DspProcessor, alloc_iq_buffer } from '../../../wasm/dsp/pkg/browsdr_dsp.js';
import { HdRadioStream } from '@/worker/decoders/hd-radio/stream';
import { HdDecoder } from '@/worker/decoders/hd-radio/decoder';

const binary = readFileSync(new URL('../../../wasm/nrsc5/pkg/nrsc5.wasm', import.meta.url));
vi.mock('/wasm/nrsc5/nrsc5.js', () => ({ default: (options) => Nrsc5Module({ ...options, wasmBinary: binary }) }));

describe('HD Radio browser WASM', () => {
	it.each([1000000, 2000000, 5000000, 10000000, 61440000])(
		'resamples %s SPS to the exact native HD rate through real WASM',
		async (rate) => {
			const wasm = await init({ module_or_path: readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url)) });
			const processor = new DspProcessor(rate, 0, 400000);
			const ptr = alloc_iq_buffer(65536);
			new Uint8Array(wasm.memory.buffer, ptr, 65536).fill(0);
			let samples = Math.round(rate * 0.02),
				output = 0;
			try {
				processor.set_if_sample_rate(744187.5);
				processor.set_bandwidth(400000);
				while (samples > 0) {
					const count = Math.min(samples, 32768);
					processor.process_iq_only_ptr(ptr, count * 2);
					output += processor.get_iq_output_len() / 2;
					samples -= count;
				}
				expect(Math.abs(output - 744187.5 * 0.02)).toBeLessThan(2);
			} finally {
				processor.free();
			}
		},
	);

	it('loads the HDC-enabled decoder and rejects broken IQ pairs', async () => {
		const numbers = [];
		const decoder = await HdDecoder.create({ onNumbers: (...args) => numbers.push(args), onText: () => {}, onAudio: () => {} });
		try {
			expect(() => decoder.process(new Float32Array(3))).toThrow('IQ pairs');
			for (let i = 0; i < 24; i++) decoder.process(new Float32Array(65536));
			expect(numbers.some(([type]) => type === 0)).toBe(false);
			decoder.reset();
		} finally {
			decoder.destroy();
		}
	});

	it('rejects insufficient input bandwidth without starting a decoder', async () => {
		const messages = [];
		const stream = new HdRadioStream(DspProcessor, { buffer: new ArrayBuffer(0) }, (message) => messages.push(message));
		stream.configure({ freq: 105.3, mode: 'hdradio' }, 500000, 105.3);
		expect(messages.at(-1).status.state).toBe('error');
		stream.configure({ freq: 106.25, mode: 'hdradio' }, 2048000, 105.3);
		expect(messages.at(-1).status.state).toBe('error');
		stream.reset();
	});

	it.skipIf(!process.env.HD_RADIO_IQ)(
		'decodes the supplied 105.3 MHz ci8 SigMF recording through the shared Rust DDC',
		async () => {
			const wasm = await init({ module_or_path: readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url)) });
			const messages = [],
				audio = [];
			const stream = new HdRadioStream(DspProcessor, wasm.memory, (message) => messages.push(message));
			const ptr = alloc_iq_buffer(65536);
			const fd = openSync(process.env.HD_RADIO_IQ, 'r');
			const bytes = Buffer.alloc(65536);
			const start = performance.now();
			let offset = 0,
				sequence = 0,
				peak = 0,
				energy = 0,
				values = 0;
			try {
				stream.configure({ freq: 105.3, mode: 'hdradio', hdProgram: Number(process.env.HD_RADIO_PROGRAM || 0) }, 2048000, 105.3);
				await stream.ready;
				expect(messages.at(-1).status.state).toBe('searching');
				const seconds = Number(process.env.HD_RADIO_SECONDS || 60);
				while (offset < seconds * 2048000 * 2) {
					const count = readSync(fd, bytes, 0, bytes.length, offset);
					if (!count) break;
					new Uint8Array(wasm.memory.buffer, ptr, count).set(bytes.subarray(0, count));
					const output = stream.process(ptr, count, false, sequence++);
					if (output) {
						values += output.length;
						for (const value of output) {
							peak = Math.max(peak, Math.abs(value));
							energy += value * value;
						}
						if (process.env.HD_RADIO_OUTPUT) audio.push(output);
					}
					offset += count;
				}
				const last = messages.at(-1).status;
				const result = {
					status: last,
					inputSeconds: offset / (2048000 * 2),
					audioSeconds: values / 96000,
					peak,
					rms: Math.sqrt(energy / values),
					elapsedSeconds: (performance.now() - start) / 1000,
				};
				console.log(JSON.stringify(result));
				if (process.env.HD_RADIO_OUTPUT) {
					writeFileSync(process.env.HD_RADIO_OUTPUT + '.json', JSON.stringify(result, null, 2));
					const wav = Buffer.alloc(44 + values * 2);
					wav.write('RIFF');
					wav.writeUInt32LE(wav.length - 8, 4);
					wav.write('WAVEfmt ', 8);
					wav.writeUInt32LE(16, 16);
					wav.writeUInt16LE(1, 20);
					wav.writeUInt16LE(2, 22);
					wav.writeUInt32LE(48000, 24);
					wav.writeUInt32LE(192000, 28);
					wav.writeUInt16LE(4, 32);
					wav.writeUInt16LE(16, 34);
					wav.write('data', 36);
					wav.writeUInt32LE(values * 2, 40);
					let position = 44;
					for (const block of audio)
						for (const value of block) {
							wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), position);
							position += 2;
						}
					writeFileSync(process.env.HD_RADIO_OUTPUT + '.wav', wav);
				}
				expect(last.station).toBeTruthy();
				expect(last.frames).toBeGreaterThan(20);
				expect(values).toBeGreaterThan(96000);
				expect(peak).toBeGreaterThan(0.001);
				expect(messages.some((message) => message.status.ber < 0.1)).toBe(true);
			} finally {
				closeSync(fd);
				stream.reset();
			}
		},
		180000,
	);
});
