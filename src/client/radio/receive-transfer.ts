/** Size reads for about 8ms of IQ, respecting wire format, packet alignment and the driver's maximum. */
export function receiveTransferSize(sampleRate: number, maximumBytes: number, bytesPerSample: number, alignment = 512): number {
	const maximumBlocks = Math.floor(maximumBytes / alignment);
	const targetBlocks = Math.floor((sampleRate * 0.008 * bytesPerSample) / alignment);
	return Math.max(1, Math.min(maximumBlocks, targetBlocks)) * alignment;
}
