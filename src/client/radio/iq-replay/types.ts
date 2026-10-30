import type { RecordingFormat } from '@/radio/iq/types';
export interface IqRecording {
	format?: RecordingFormat;
	precisionBits?: number;
	file: File;
	sampleRate: number;
	centerHz: number;
	frequencyShiftHz: number;
	datetime?: string;
	missingSamples?: number | null;
}

export interface IqReplayProgress {
	state: 'ready' | 'playing' | 'paused' | 'draining' | 'ended' | 'error';
	seconds: number;
	duration: number;
	delaySeconds: number;
	error?: string;
}
