import { describe, expect, it } from 'vitest';
import { WavRecording, MAX_RECORDING_SECONDS, RECORDING_SAMPLE_RATE } from '@/app/audio/wav';

describe('lossless WAV recording', () => {
	it('writes a valid stereo WAV across mono/stereo changes and retains silent frames', async () => {
		const recording = new WavRecording();
		recording.append(new Float32Array([0, -1, 1]), 1);
		recording.append(new Float32Array([0.5, -0.5]), 2);
		const blob = recording.finish();
		const buffer = await blob.arrayBuffer();
		const view = new DataView(buffer);
		expect(blob.type).toBe('audio/wav');
		expect(new TextDecoder().decode(buffer.slice(0, 4))).toBe('RIFF');
		expect(new TextDecoder().decode(buffer.slice(8, 12))).toBe('WAVE');
		expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(2);
		expect(view.getUint32(24, true)).toBe(48000);
		expect(view.getUint32(28, true)).toBe(192000);
		expect(view.getUint16(32, true)).toBe(4);
		expect(view.getUint16(34, true)).toBe(16);
		expect(view.getUint32(40, true)).toBe(16);
		expect(Array.from({ length: 8 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([
			0, 0, -32768, -32768, 32767, 32767, 16384, -16384,
		]);
		expect(recording.seconds).toBe(4 / 48000);
	});
	it('owns captured samples before playback transfers their buffer and clips invalid values', async () => {
		const recording = new WavRecording();
		const samples = new Float32Array([2, -2, NaN, Infinity]);
		recording.append(samples, 2);
		structuredClone(samples, { transfer: [samples.buffer] });
		const view = new DataView(await recording.finish().arrayBuffer());
		expect(Array.from({ length: 4 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([32767, -32768, 0, 0]);
	});
	it('limits the final batch to exactly five minutes', () => {
		const recording = new WavRecording();
		recording.frames = MAX_RECORDING_SECONDS * RECORDING_SAMPLE_RATE - 2;
		expect(recording.append(new Float32Array(10), 1)).toBe(true);
		expect(recording.seconds).toBe(300);
		expect(recording.append(new Float32Array(10), 2)).toBe(true);
		expect(recording.seconds).toBe(300);
	});
});
