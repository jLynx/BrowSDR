import { describe, expect, it } from 'vitest';
import { encodeRecording } from '@/radio/iq/format';
import { IqCapture } from '@/worker/recording/iq-capture';
import { recordingFromSigmf } from '@/radio/iq-replay/metadata';

describe('IQ recording precision', () => {
	it('encodes signed full-scale samples with explicit little-endian metadata formats', () => {
		const samples = new Int16Array([-32768, 32767, -16, 16, -256, 256]);
		expect([...encodeRecording(samples, 'ci8')]).toEqual([-128, 127, -1, 0, -1, 1]);
		const words = encodeRecording(samples, 'ci16_le');
		expect([...new Uint8Array(words.buffer).slice(0, 4)]).toEqual([0, 128, 255, 127]);
		expect([...new Int16Array(words.buffer)]).toEqual([...samples]);
		const floats = new Float32Array(encodeRecording(samples, 'cf32_le').buffer);
		expect([...floats]).toEqual([...samples].map((value) => value / 32768));
		expect([...encodeRecording(new Float32Array([-2, 2, -1 / 128, 1 / 128]), 'ci8')]).toEqual([-128, 127, -1, 1]);
	});

	it.each(['ci8', 'ci16_le', 'cf32_le'] as const)('captures exactly the requested sample duration as %s', async (format) => {
		const capture = new IqCapture();
		const result = capture.start(2, 1, format);
		capture.push(new Int16Array([-32768, 32767]));
		expect(capture.progress?.format).toBe(format);
		capture.push(new Int16Array([-16, 16, 123, 456]));
		expect([...(await result)]).toEqual([...encodeRecording(new Int16Array([-32768, 32767, -16, 16]), format)]);
		expect(capture.progress).toBeNull();
	});

	it('copies native 16-bit file input before a USB buffer is reused', async () => {
		const blocks: Int8Array[] = [];
		const writer = {
			write: async (block: Int8Array) => {
				blocks.push(block.slice());
			},
			close: async () => {},
			abort: async () => {},
		};
		const file = { name: 'iq.sigmf-data', createWritable: async () => writer } as unknown as FileSystemFileHandle;
		const capture = new IqCapture();
		const result = capture.startToFile(2, 1, file, undefined, 'ci16_le');
		const samples = new Int16Array([-32768, 32767, -16, 16]);
		capture.push(samples);
		samples.fill(123);
		expect(await result).toBe(8);
		expect([...new Int16Array(blocks[0].buffer)]).toEqual([-32768, 32767, -16, 16]);
	});

	it.each(['ci16_le', 'cf32_le'])('accepts its own %s recordings for replay and rejects partial pairs', (format) => {
		const bytes = format === 'ci16_le' ? 4 : 8;
		const meta = JSON.stringify({
			global: { 'core:datatype': format, 'core:sample_rate': 1e6, 'browsdr:iq_precision_bits': 12 },
			captures: [{ 'core:sample_start': 0, 'core:frequency': 100e6 }],
		});
		expect(recordingFromSigmf(new File([new Uint8Array(bytes * 2)], 'iq'), meta)).toMatchObject({ format, precisionBits: 12 });
		expect(() => recordingFromSigmf(new File([new Uint8Array(bytes + 2)], 'iq'), meta)).toThrow('complete I/Q pairs');
	});
});
