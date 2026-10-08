import type { AppInstance } from '@/app/core/receiver.types';

export const audioMethods = {
	playAudio(this: AppInstance, samples: Float32Array | Record<number, number>, channels: 1 | 2 = 1) {
		if (!this.vfos.some((v) => v.enabled) || !this.audioCtx) return;
		if (this.audioCtx.state === 'suspended') {
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
		if (this.nextPlayTime < now) {
			// Fallen behind — reschedule with minimal gap
			this.nextPlayTime = now + 0.01;
		}
		src.start(this.nextPlayTime);
		this.nextPlayTime += buffer.duration;

		this.queuedAudioSched = (this.nextPlayTime - context.currentTime).toFixed(2);
	},
};
