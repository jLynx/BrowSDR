export const IQ_MEMORY_LIMIT = 64 * 1024 * 1024;
export const IQ_FILE_BLOCK_SIZE = 1024 * 1024;

export function iqCaptureByteLength(sampleRate: number, seconds: number): number {
	const samples = Math.round(sampleRate * seconds);
	if (
		!Number.isFinite(seconds) ||
		seconds <= 0 ||
		!Number.isFinite(sampleRate) ||
		sampleRate <= 0 ||
		samples < 1 ||
		!Number.isSafeInteger(samples * 2)
	)
		throw new Error('Choose a positive IQ capture duration and sample rate');
	return samples * 2;
}

export function iqCaptureTimeout(seconds: number): number {
	return Math.min(2147483647, Math.max(10000, seconds * 3000));
}
