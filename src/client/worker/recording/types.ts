import type { RecordingFormat } from '@/radio/iq/types';
export interface IqCaptureProgress {
	format?: RecordingFormat;
	capturedBytes: number;
	writtenBytes: number;
	totalBytes: number | null;
	phase?: 'recording' | 'flushing' | 'finalizing';
}
