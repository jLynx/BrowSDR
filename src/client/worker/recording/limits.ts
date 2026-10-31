import { recordingBytesPerSample } from '@/radio/iq/format';
import type { RecordingFormat } from '@/radio/iq/types';

export const IQ_MEMORY_LIMIT = 64 * 1024 * 1024;
export const IQ_FILE_BLOCK_SIZE = 1024 * 1024;

export function iqCaptureByteLength(sampleRate: number, seconds: number, format: RecordingFormat = 'ci8'): number {
	const samples = Math.round(sampleRate * seconds);
	const bytes = samples * recordingBytesPerSample(format);
	if (
		!Number.isFinite(seconds) ||
		seconds <= 0 ||
		!Number.isFinite(sampleRate) ||
		sampleRate <= 0 ||
		samples < 1 ||
		!Number.isSafeInteger(bytes)
	)
		throw new Error('Choose a positive IQ capture duration and sample rate');
	return bytes;
}

export function iqCaptureTimeout(seconds: number): number {
	return Math.min(2147483647, Math.max(10000, seconds * 3000));
}
