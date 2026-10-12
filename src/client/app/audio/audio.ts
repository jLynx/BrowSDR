import type { AppInstance } from '@/app/core/receiver.types';
import { workletMethods } from './worklet';

// Fallback playback schedules 50ms chunks. Keep two chunks of headroom
// for short UI/background delays when AudioWorklet is unavailable.
const AUDIO_SCHEDULE_LEAD_SECONDS = 0.1;

export const audioMethods = {
	...workletMethods,
	playAudio(this: AppInstance, samples: Float32Array | Record<number, number>, channels: 1 | 2 = 1) {
		if (!this.vfos.some((v) => v.enabled) || !this.audioCtx) {
			if (!this._audioPlaybackPaused) this._resetAudioPlayback();
			return;
		}
		if (this.audioCtx.state === 'suspended') {
			if (!this._audioPlaybackPaused) this._resetAudioPlayback();
			this.audioCtx.resume().catch(() => {});
			return;
		}

		let floats: Float32Array;
		if (samples instanceof Float32Array) floats = samples;
		else {
			const len = Object.keys(samples).length;
			floats = new Float32Array(len);
			for (let i = 0; i < len; i++) floats[i] = samples[i];
		}

		if (!floats.length) return;
		if (floats.length % channels) return;
		this._audioPlaybackPaused = false;
		if (this._audioWorklet) {
			// Comlink delivered an owned buffer; transfer it straight to the audio thread.
			this._audioWorklet.port.postMessage({ type: 'pcm', samples: floats, channels }, [floats.buffer]);
			return;
		}
		if (this.audioRingChannels !== channels) {
			this.audioRingPos = 0;
			this.audioRingChannels = channels;
			this.audioRingBuf = new Float32Array(4800 * channels);
		}

		// Accumulate into ring buffer, schedule when we have enough
		// This batches tiny chunks (~786 samples) into larger buffers
		// to prevent scheduling gaps on the main thread
		const SCHEDULE_THRESHOLD = 2400 * channels; // 50ms at 48kHz
		let srcOffset = 0;
		while (srcOffset < floats.length) {
			const space = this.audioRingBuf.length - this.audioRingPos;
			const toCopy = Math.min(space, floats.length - srcOffset);
			this.audioRingBuf.set(floats.subarray(srcOffset, srcOffset + toCopy), this.audioRingPos);
			this.audioRingPos += toCopy;
			srcOffset += toCopy;

			this.audioRingSize = (this.audioRingPos / SCHEDULE_THRESHOLD).toFixed(2);

			if (this.audioRingPos >= SCHEDULE_THRESHOLD) {
				this._scheduleAudioChunk(this.audioRingBuf.slice(0, this.audioRingPos), channels);
				this.audioRingPos = 0;
			}
		}
	},
	_scheduleAudioChunk(this: AppInstance, floats: Float32Array, channels: 1 | 2 = 1) {
		const context = this.audioCtx;
		const gain = this.gainNode;
		if (!context || !gain) return;
		const buffer = context.createBuffer(channels, floats.length / channels, 48000);
		for (let channel = 0; channel < channels; channel++) {
			const target = buffer.getChannelData(channel);
			for (let frame = 0; frame < target.length; frame++) target[frame] = floats[frame * channels + channel];
		}

		const src = context.createBufferSource();
		src.buffer = buffer;
		src.connect(gain);

		const now = context.currentTime;
		if (this.nextPlayTime === 0 || this.nextPlayTime < now) {
			// Startup/reset has no preceding audio. Count subsequent exhausted
			// schedules once when audio resumes, including the recovery padding.
			if (this.nextPlayTime > 0) {
				this.audioGapCount = (this.audioGapCount ?? 0) + 1;
				this.audioGapMs = (this.audioGapMs ?? 0) + (now + AUDIO_SCHEDULE_LEAD_SECONDS - this.nextPlayTime) * 1000;
			}
			// Establish a reserve at startup, and rebuild it after an underrun.
			this.nextPlayTime = now + AUDIO_SCHEDULE_LEAD_SECONDS;
		}
		src.start(this.nextPlayTime);
		this.nextPlayTime += buffer.duration;

		this.queuedAudioSched = (this.nextPlayTime - context.currentTime).toFixed(2);
	},
};
