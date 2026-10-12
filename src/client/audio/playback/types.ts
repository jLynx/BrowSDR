import type { AudioChannels } from '@/audio/types';

export type PlaybackMessage = { type: 'pcm'; samples: Float32Array; channels: AudioChannels } | { type: 'reset'; clearCounters?: boolean };

export interface PlaybackStats {
	queueMs: number;
	targetMs: number;
	rate: number;
	gapCount: number;
	gapMs: number;
	droppedFrames: number;
}

declare global {
	const sampleRate: number;
	const currentTime: number;
	class AudioWorkletProcessor {
		readonly port: MessagePort;
	}
	function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
}
