import type { IioSampleFormat } from './types';

/** Formats this driver can narrow to signed 8-bit IQ: little-endian signed samples in 16-bit words. */
export function isSupportedSampleFormat(format: IioSampleFormat | null): format is IioSampleFormat {
	return (
		!!format && format.littleEndian && format.signed && format.storageBits === 16 && format.bits >= 8 && format.bits + format.shift <= 16
	);
}

/**
 * Narrow interleaved I/Q words (12-bit AD936x samples on PlutoSDR) to the
 * signed 8-bit IQ the DSP pipeline consumes, keeping the top 8 bits.
 */
export function narrowIq(data: Uint8Array, format: IioSampleFormat, out: Int8Array, offset: number): void {
	const aligned = data.byteOffset % 2 === 0 ? data : data.slice();
	const words = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength >> 1);
	// Sign-extend from `bits`, then drop the low bits beyond 8 in one shift pair.
	const up = 32 - format.bits;
	const down = up + format.bits - 8;
	const { shift } = format;
	for (let i = 0; i < words.length; i++) out[offset + i] = ((words[i] >> shift) << up) >> down;
}
