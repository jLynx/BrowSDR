import type { GainControl } from '@/radio/types';

import type { IqFormat, IqSamples, RecordingFormat } from './types';

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function iqPrecisionControl(bits: 12 | 16): GainControl {
	const labels = bits === 12 ? ['12-bit (16-bit storage)', '8-bit'] : ['16-bit', '12-bit (16-bit storage)', '8-bit'];
	return { name: 'IQ Precision', min: 0, max: labels.length - 1, step: 1, default: 0, labels, type: 'select' };
}

export function selectedIqBits(native: 12 | 16, selection: number): 8 | 12 | 16 {
	const bits = native === 12 ? [12, 8] : [16, 12, 8];
	if (!Number.isInteger(selection) || selection < 0 || selection >= bits.length) throw new Error('Unsupported IQ precision');
	return bits[selection] as 8 | 12 | 16;
}

export function iqView(data: ArrayBufferView, format: IqFormat): IqSamples {
	if (data.byteLength % (iqComponentBytes(format) * 2)) throw new Error('Incomplete IQ pair');
	if (format === 'float32') return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
	return format === 'int16'
		? new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2)
		: new Int8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function iqComponentBytes(format: IqFormat): number {
	return format === 'int8' ? 1 : format === 'int16' ? 2 : 4;
}

export function sampleIqFormat(samples: IqSamples): IqFormat {
	return samples instanceof Float32Array ? 'float32' : samples instanceof Int16Array ? 'int16' : 'int8';
}

export function deviceIqFormat(format?: 'int8' | 'uint8' | 'int16' | 'float32'): IqFormat {
	return format === 'uint8' || format === undefined ? 'int8' : format;
}

export function recordingBytesPerSample(format: RecordingFormat): number {
	return format === 'ci8' ? 2 : format === 'ci16_le' ? 4 : 8;
}

/** Full-scale signed containers: int16 components are left-aligned, including 12-bit sources. */
export function encodeRecording(samples: IqSamples, format: RecordingFormat): Int8Array<ArrayBufferLike> {
	if (format === 'ci8' && samples instanceof Int8Array) return samples;
	if (
		littleEndian &&
		((format === 'ci16_le' && samples instanceof Int16Array) || (format === 'cf32_le' && samples instanceof Float32Array))
	)
		return new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength);
	const bytes = new Int8Array(samples.length * (recordingBytesPerSample(format) / 2));
	const view = new DataView(bytes.buffer);
	const scale = samples instanceof Float32Array ? 1 : samples instanceof Int16Array ? 32768 : 128;
	for (let i = 0; i < samples.length; i++) {
		if (format === 'ci8') bytes[i] = Math.max(-128, Math.min(127, Math.floor(samples[i] * (128 / scale))));
		else if (format === 'ci16_le') view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * (32768 / scale)))), true);
		else view.setFloat32(i * 4, samples[i] / scale, true);
	}
	return bytes;
}
