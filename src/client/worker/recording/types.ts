export interface IqCaptureProgress {
	capturedBytes: number;
	writtenBytes: number;
	totalBytes: number | null;
	phase?: 'recording' | 'flushing' | 'finalizing';
}
