import type { IioSampleFormat } from './types';

/** Formats this driver can convert to signed IQ: little-endian signed samples in 16-bit words. */
export function isSupportedSampleFormat(format: IioSampleFormat | null): format is IioSampleFormat {
	return (
		!!format && format.littleEndian && format.signed && format.storageBits === 16 && format.bits >= 8 && format.bits + format.shift <= 16
	);
}

/**
 * Convert interleaved I/Q words (12-bit AD936x samples on PlutoSDR) to the
 * DSP's signed IQ: left-aligned full-scale int16, or the top 8 bits as int8.
 */
export function convertIq(data: Uint8Array, format: IioSampleFormat, out: Int8Array | Int16Array, offset: number): void {
	const aligned = data.byteOffset % 2 === 0 ? data : data.slice();
	const words = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength >> 1);
	// Sign-extend from `bits` to the top of 32, then shift down to the output width.
	const up = 32 - format.bits;
	const down = out instanceof Int16Array ? 16 : 24;
	const { shift } = format;
	for (let i = 0; i < words.length; i++) out[offset + i] = ((words[i] >> shift) << up) >> down;
}
