import type { AudioChannels } from '@/audio/types';

export const PLAYBACK_BUFFER_LIMITS = [100, 250, 500] as const;
export type PlaybackBufferLimit = (typeof PLAYBACK_BUFFER_LIMITS)[number];
export const LOCAL_PLAYBACK_LIMIT_MS = PLAYBACK_BUFFER_LIMITS[0];
export const DEFAULT_REMOTE_PLAYBACK_LIMIT_MS = PLAYBACK_BUFFER_LIMITS[2];

export type PlaybackMessage =
	| { type: 'pcm'; samples: Float32Array; channels: AudioChannels }
	| { type: 'reset'; clearCounters?: boolean; maxBufferMs?: PlaybackBufferLimit }
	| { type: 'setLimit'; maxBufferMs: PlaybackBufferLimit };

export interface PlaybackStats {
	queueMs: number;
	targetMs: number;
	rate: number;
	gapCount: number;
	gapMs: number;
	droppedFrames: number;
	maxArrivalGapMs: number | null;
}

declare global {
	const sampleRate: number;
	const currentTime: number;
	class AudioWorkletProcessor {
		readonly port: MessagePort;
	}
	function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
}
