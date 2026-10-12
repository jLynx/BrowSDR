export interface MediaSessionReceiver {
	connected: boolean;
	running: boolean;
	_removing?: boolean;
	_mediaAudioEl?: HTMLAudioElement | null;
	audioCtx?: AudioContext | null;
	togglePlay(): Promise<void>;
}
