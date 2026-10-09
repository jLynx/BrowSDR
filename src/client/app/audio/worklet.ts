import { markRaw } from 'vue';
import workletUrl from '@/audio/playback/processor?worker&url';
import type { AppInstance } from '@/app/core/receiver.types';
import type { PlaybackStats } from '@/audio/playback/types';

export const workletMethods = {
	_prepareAudioWorklet(this: AppInstance): Promise<void> {
		if (this._audioWorkletReady) return this._audioWorkletReady;
		const context = this.audioCtx;
		if (!context?.audioWorklet) return Promise.resolve();
		const ready = context.audioWorklet
			.addModule(workletUrl)
			.then(() => {
				if (this._audioWorkletReady !== ready || this.audioCtx !== context || context.state === 'closed' || !this.gainNode) return;
				const node = new AudioWorkletNode(context, 'radio-playback', { numberOfInputs: 0, outputChannelCount: [2] });
				node.port.onmessage = (event: MessageEvent<PlaybackStats>) => {
					if (this._audioWorklet !== node) return;
					const stats = event.data;
					this.queuedAudioSched = (stats.queueMs / 1000).toFixed(4);
					this.audioTargetMs = stats.targetMs;
					this.audioPlaybackRate = stats.rate;
					this.audioGapCount = stats.gapCount;
					this.audioGapMs = stats.gapMs;
					this.audioDroppedFrames = stats.droppedFrames;
				};
				node.connect(this.gainNode);
				this._audioWorklet = markRaw(node);
				this.audioPlaybackEngine = 'worklet';
			})
			.catch((error: unknown) => {
				console.warn('AudioWorklet unavailable; using scheduled playback:', error);
			});
		this._audioWorkletReady = ready;
		return ready;
	},
	_resetAudioPlayback(this: AppInstance, clearCounters = false) {
		this.nextPlayTime = 0;
		this.audioRingPos = 0;
		this._audioPlaybackPaused = true;
		this._audioWorklet?.port.postMessage({ type: 'reset', clearCounters });
		this.queuedAudioSched = '0';
		if (clearCounters) {
			this.audioGapCount = this.audioGapMs = this.audioDroppedFrames = 0;
			this.audioTargetMs = 20;
			this.audioPlaybackRate = 1;
		}
	},
	_disposeAudioWorklet(this: AppInstance) {
		if (this._audioWorklet) {
			this._audioWorklet.port.onmessage = null;
			this._audioWorklet.port.close();
			this._audioWorklet.disconnect();
		}
		this._audioWorklet = null;
		this._audioWorkletReady = null;
		this.audioPlaybackEngine = 'scheduled';
	},
};
