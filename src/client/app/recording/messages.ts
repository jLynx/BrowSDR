import { formatIqSize } from './sigmf';
import type { AppInstance } from '@/app/core/receiver.types';
import { IQ_MEMORY_LIMIT } from '@/worker/recording/limits';

export function recordingBlockedReason(receiver: AppInstance, bytes: number, canSaveToFile: boolean): string {
	if (!bytes) return 'Enter a recording duration greater than zero.';
	if (receiver.remoteMode === 'client') return 'Connect a local SDR to record IQ. Remote reception cannot be recorded.';
	if (!receiver.running) return 'Start reception, then select Start recording.';
	if (receiver.autoGain.active) return 'Wait for automatic gain adjustment to finish before recording.';
	if (bytes > IQ_MEMORY_LIMIT && !canSaveToFile)
		return `This recording exceeds the 64 MiB download limit. Use Chrome or Edge to save directly to a file, or reduce the duration to ${(IQ_MEMORY_LIMIT / receiver.radio.sampleRate / 2).toFixed(2)} seconds or less.`;
	return '';
}

export function recordingComplete(bytes: number, sampleRate: number, missingSamples: number | null, savedToFile: boolean): string {
	const continuity =
		missingSamples === null
			? 'This receiver does not report sample loss.'
			: missingSamples === 0
				? 'No missing USB samples reported.'
				: `${missingSamples.toLocaleString()} USB samples were missing; the recording may contain gaps.`;
	return `Recorded ${(bytes / 2 / sampleRate).toFixed(3)} s · ${formatIqSize(bytes)}. ${savedToFile ? 'IQ data saved. Download its metadata below.' : 'Your recording is ready to download.'} ${continuity}`;
}
