/** PCM values are interleaved L/R when channels === 2. Lengths in queues
 * and timing code count frames, not individual float values. */
import type { AudioChannels } from './types';

export function downmix(samples: Float32Array, channels: AudioChannels): Float32Array {
	if (channels === 1) return samples;
	const mono = new Float32Array(samples.length / 2);
	for (let i = 0; i < mono.length; i++) mono[i] = (samples[2 * i] + samples[2 * i + 1]) * 0.5;
	return mono;
}

// Legacy mono packets remain raw Float32 PCM. Stereo packets have a versioned
// header, inside the existing receiver envelope, followed by interleaved PCM.
const MAGIC = 0x32524453; // SDR2
export function packAudio(samples: Float32Array, channels: AudioChannels): ArrayBuffer | Float32Array {
	if (channels === 1) return samples;
	const buffer = new ArrayBuffer(16 + samples.byteLength);
	const header = new DataView(buffer);
	header.setUint32(0, MAGIC, true);
	header.setUint32(4, 1, true);
	header.setUint32(8, 2, true);
	header.setUint32(12, 48000, true);
	new Float32Array(buffer, 16).set(samples);
	return buffer;
}

export function unpackAudio(chunk: ArrayBuffer | Float32Array): { samples: Float32Array; channels: AudioChannels } {
	const buffer = chunk instanceof Float32Array ? chunk.buffer : chunk;
	const offset = chunk instanceof Float32Array ? chunk.byteOffset : 0;
	const length = chunk.byteLength;
	const header = new DataView(buffer, offset, length);
	if (length >= 16 && header.getUint32(0, true) === MAGIC) {
		if (
			header.getUint32(4, true) !== 1 ||
			header.getUint32(8, true) !== 2 ||
			header.getUint32(12, true) !== 48000 ||
			(length - 16) % 8 !== 0
		) {
			throw new Error('Invalid stereo audio packet');
		}
		return { samples: new Float32Array(buffer, offset + 16, (length - 16) / 4), channels: 2 };
	}
	return { samples: chunk instanceof Float32Array ? chunk : new Float32Array(chunk), channels: 1 };
}
