import type { WatchOptions, WatchStopHandle } from 'vue';
import type { Remote } from 'comlink';
import type { Backend } from '../../worker/runtime/backend';
import type { createAppData } from './state';
import type { Waterfall, WaterfallGL } from '../../display/utils';
import type { SpectrumFrameLimiter, WaterfallClock } from '../../display/spectrum-rate';
import type { WebRTCHandler } from '../../remote/webrtc';
import type { ReceiverTransport } from '../../remote/receiver-transport';
import type { Vfo, Bookmark } from './types';
import type { WorkspaceInstance } from '../workspace/types';

import type { ReceiverMethods } from './methods';

export interface WhisperVfoState {
	buf: Float32Array[];
	bufLen: number;
	silenceRun: number;
	recording: boolean;
	recordStart: Date | null;
	recordStartFreq: string;
	activitySeen?: boolean;
}
export interface WhisperChunkMeta {
	startTime?: Date | null;
	freq?: string;
	vfoIndex?: number;
	model?: string;
}
export interface ReceiverInternals {
	receiverId: string;
	settingsKey: string;
	workspace: WorkspaceInstance | null;
	backend: Remote<Backend>;
	$el: HTMLElement;
	$refs: Record<string, HTMLElement> & { fft: HTMLCanvasElement; waterfall: HTMLCanvasElement; bookmarkNameInput: HTMLInputElement };
	$nextTick(callback?: () => void): Promise<void>;
	$watch<T>(source: (() => T) | string, callback: (value: T, previous: T) => void | Promise<void>, options?: WatchOptions): WatchStopHandle;
	activeAudioVfos: Array<{ index: number; vfo: Vfo }>;
	minFreq: number;
	maxFreq: number;

	audioCtx: AudioContext | null;
	gainNode: GainNode | null;
	audioRingBuf: Float32Array;
	audioRingPos: number;
	audioRingSize: string;
	queuedAudioSched: string;
	nextPlayTime: number;
	renderSize: number;
	_fftCtx: CanvasRenderingContext2D;
	_waterfallEngine: (Waterfall | WaterfallGL) & { destroy?: () => void };
	_waterfallClock: WaterfallClock;
	_remoteSpectrumLimiter: SpectrumFrameLimiter;
	_lastSpectrumData?: Float32Array;
	_zoomRepaint?: boolean;
	_lastFrameTime: number;
	_framesDrawn: number;
	_mediaAudioEl: HTMLAudioElement | null;
	_mediaSource: MediaSource | null;
	_silentMp3Data: ArrayBuffer | null;
	_wakeLock: WakeLockSentinel | null;
	_statsTimer: ReturnType<typeof setInterval> | null;
	_backendWorker?: Worker;
	_whisperWorker: Worker | null;
	_whisperBenchmarkAudio?: Float32Array;
	_whisperBenchmarkModel?: string;
	_whisperChunkId: number;
	_whisperChunkMeta: Record<number, WhisperChunkMeta>;
	_whisperVfoStates: Record<number, WhisperVfoState>;
	_webrtc: WebRTCHandler | ReceiverTransport | null;
	_receiverTransport: ReceiverTransport | null;
	_cleanup: Array<() => void>;
	_canvasCleanup?: () => void;
	_disposeHeaderTools?: () => void;
	_disposed?: boolean;
	_removing?: boolean;
	_connectingDevice?: boolean;
	_playChanging?: boolean;
	_disconnecting?: boolean;
	_applyingSync?: boolean;
	_hostRunning?: boolean;
	_resumeAfterHostPause?: boolean;
	_pendingImportFile: File | null;
}
export type AppInstance = Omit<ReturnType<typeof createAppData>, 'backend'> & ReceiverInternals & ReceiverMethods;
export type BookmarkEntry = { bm: Bookmark; i: number };
