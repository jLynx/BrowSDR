import { recordingBytesPerSample } from '@/radio/iq/format';
import { isRecord } from '@/platform/data';
import type { IqRecording } from './types';

export function validateIqRecording(recording: IqRecording): void {
	if (!recording.file.size || recording.file.size % recordingBytesPerSample(recording.format ?? 'ci8'))
		throw new Error('IQ data must contain complete I/Q pairs.');
	if (!Number.isFinite(recording.sampleRate) || recording.sampleRate < 1000 || recording.sampleRate > 61440000)
		throw new Error('Choose a sample rate between 1 kSPS and 61.44 MSPS.');
	if (
		!Number.isFinite(recording.centerHz) ||
		recording.centerHz < 0 ||
		!Number.isFinite(recording.frequencyShiftHz) ||
		recording.centerHz + recording.frequencyShiftHz < 0
	)
		throw new Error('Recorded and displayed centre frequencies must be finite and non-negative.');
}

/** BrowSDR records one continuous, uncompressed SigMF capture. */
export function recordingFromSigmf(file: File, text: string): IqRecording {
	const meta: unknown = JSON.parse(text);
	if (!isRecord(meta) || !isRecord(meta.global) || !Array.isArray(meta.captures) || meta.captures.length !== 1)
		throw new Error('Select SigMF metadata containing one continuous capture.');
	const global = meta.global,
		capture: unknown = meta.captures[0];
	const format = global['core:datatype'];
	if (format !== 'ci8' && format !== 'ci16_le' && format !== 'cf32_le')
		throw new Error('Replay supports ci8, ci16_le and cf32_le: I first, Q second.');
	if (!isRecord(capture) || capture['core:sample_start'] !== 0 || global['core:offset'] || global['core:trailing_bytes'])
		throw new Error('Capture offsets, multiple tuning segments and trailing bytes are not supported.');
	const rate = global['core:sample_rate'],
		center = capture['core:frequency'],
		shift = global['browsdr:frequency_shift_hz'] ?? 0;
	if (typeof rate !== 'number' || typeof center !== 'number' || typeof shift !== 'number')
		throw new Error('Metadata needs a numeric sample rate and centre frequency.');
	const missing = global['browsdr:missing_samples'];
	const recording: IqRecording = {
		file,
		format,
		precisionBits: readPrecisionBits(global['browsdr:iq_precision_bits']),
		sampleRate: rate,
		centerHz: center,
		frequencyShiftHz: shift,
		datetime: typeof capture['core:datetime'] === 'string' ? capture['core:datetime'] : undefined,
		missingSamples: typeof missing === 'number' && Number.isFinite(missing) && missing >= 0 ? missing : null,
	};
	validateIqRecording(recording);
	return recording;
}

function readPrecisionBits(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 8 && value <= 32 ? value : undefined;
}
