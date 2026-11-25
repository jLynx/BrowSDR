import type { AudioChannels } from '@/audio/types';
import { LOCAL_PLAYBACK_LIMIT_MS } from './types';
import type { PlaybackBufferLimit, PlaybackStats } from './types';

const INPUT_RATE = 48000;
const FRAMES_PER_MS = INPUT_RATE / 1000;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Bounded stereo queue, consumed exclusively by the audio rendering thread. */
export class AdaptivePlaybackBuffer {
	private limitMs: PlaybackBufferLimit = LOCAL_PLAYBACK_LIMIT_MS;
	private left = new Float32Array(this.limitMs * FRAMES_PER_MS);
	private right = new Float32Array(this.left.length);
	private read = 0;
	private length = 0;
	private fraction = 0;
	private channels: AudioChannels = 1;
	private playing = false;
	private started = false;
	private recovering = false;
	private lastArrival = -1;
	private lastPacketMs = 5;
	private packetMs = 5;
	private jitterMs = 0;
	private targetMs = 20;
	private smoothedQueueMs = 20;
	private rate = 1;
	private gapCount = 0;
	private gapMs = 0;
	private droppedFrames = 0;
	private maxArrivalGapMs: number | null = null;

	setLimit(limitMs: PlaybackBufferLimit) {
		if (limitMs === this.limitMs) return;
		const left = new Float32Array(limitMs * FRAMES_PER_MS);
		const right = new Float32Array(left.length);
		// Keep the newest audio when the listener chooses a lower latency limit.
		const length = Math.min(this.length, left.length);
		const start = this.read + this.length - length;
		for (let frame = 0; frame < length; frame++) {
			const index = (start + frame) % this.left.length;
			left[frame] = this.left[index];
			right[frame] = this.right[index];
		}
		if (length !== this.length) this.fraction = 0;
		this.length = length;
		this.read = 0;
		this.left = left;
		this.right = right;
		this.limitMs = limitMs;
		this.targetMs = Math.min(this.targetMs, limitMs);
		this.jitterMs = Math.min(this.jitterMs, limitMs);
		this.smoothedQueueMs = Math.min(this.smoothedQueueMs, limitMs);
	}

	reset(clearCounters = false) {
		this.read = this.length = this.fraction = 0;
		this.playing = this.started = this.recovering = false;
		this.lastArrival = -1;
		this.lastPacketMs = this.packetMs = 5;
		this.jitterMs = 0;
		this.targetMs = this.smoothedQueueMs = 20;
		this.rate = 1;
		if (clearCounters) {
			this.gapCount = this.gapMs = this.droppedFrames = 0;
			this.maxArrivalGapMs = null;
		}
	}

	push(samples: Float32Array, channels: AudioChannels, nowSeconds: number) {
		if (!samples.length || samples.length % channels) return;
		if (this.channels !== channels) this.reset();
		this.channels = channels;
		const frames = samples.length / channels;
		this.observeArrival(frames / FRAMES_PER_MS, nowSeconds);
		const capacity = this.left.length;
		const dropped = Math.max(0, this.length + frames - capacity);
		if (dropped > 0) {
			const queuedDrop = Math.min(this.length, dropped);
			this.read = (this.read + queuedDrop) % capacity;
			this.length -= queuedDrop;
			this.fraction = 0;
			this.droppedFrames += dropped;
		}
		const skip = Math.max(0, frames - capacity);
		for (let frame = skip; frame < frames; frame++) {
			const index = (this.read + this.length) % capacity;
			this.left[index] = samples[frame * channels];
			this.right[index] = samples[frame * channels + (channels === 2 ? 1 : 0)];
			this.length++;
		}
	}

	private observeArrival(durationMs: number, now: number) {
		const elapsedMs = this.lastArrival < 0 ? 0 : Math.max(0, (now - this.lastArrival) * 1000);
		if (this.lastArrival >= 0) this.maxArrivalGapMs = Math.max(this.maxArrivalGapMs ?? 0, elapsedMs);
		// Peaks decay slowly; catch-up bursts don't erase evidence of a stall.
		const decay = Math.exp(-elapsedMs / 10000);
		this.packetMs = Math.max(durationMs, this.packetMs * decay);
		this.jitterMs = Math.max(Math.min(this.limitMs, elapsedMs - this.lastPacketMs), this.jitterMs * decay, 0);
		const required = clamp(this.packetMs + this.jitterMs + 3, 5, this.limitMs);
		// Let larger reserves drain faster, within the 5 ms/s rate correction can absorb.
		const decayMsPerSecond = this.limitMs === LOCAL_PLAYBACK_LIMIT_MS ? 0.2 : 2;
		this.targetMs = Math.max(required, this.targetMs - (elapsedMs * decayMsPerSecond) / 1000);
		this.lastPacketMs = durationMs;
		this.lastArrival = now;
	}

	render(output: Float32Array[], outputRate: number) {
		const frames = output[0]?.length ?? 0;
		for (const channel of output) channel.fill(0);
		if (!frames) return;
		if (!this.playing && this.length >= this.targetMs * FRAMES_PER_MS) {
			this.playing = this.started = true;
			this.recovering = false;
			this.smoothedQueueMs = this.length / FRAMES_PER_MS;
		}
		if (!this.playing) {
			if (this.recovering) this.gapMs += (frames / outputRate) * 1000;
			return;
		}
		this.adjustRate(frames / outputRate);
		const step = (INPUT_RATE / outputRate) * this.rate;
		for (let frame = 0; frame < frames; frame++) {
			const advance = Math.floor(this.fraction + step);
			if (this.length < Math.max(2, advance)) {
				this.underrun(((frames - frame) / outputRate) * 1000);
				break;
			}
			const next = (this.read + 1) % this.left.length;
			output[0][frame] = this.left[this.read] + (this.left[next] - this.left[this.read]) * this.fraction;
			if (output[1]) output[1][frame] = this.right[this.read] + (this.right[next] - this.right[this.read]) * this.fraction;
			this.read = (this.read + advance) % this.left.length;
			this.length -= advance;
			this.fraction = this.fraction + step - advance;
		}
	}

	private adjustRate(seconds: number) {
		// Smooth the sawtooth between packet arrivals before steering the clock.
		const smoothing = 1 - Math.exp(-seconds / 0.2);
		this.smoothedQueueMs += (this.length / FRAMES_PER_MS - this.smoothedQueueMs) * smoothing;
		const desiredMean = Math.min(this.targetMs + this.packetMs / 2, this.limitMs - this.packetMs / 2 - 3);
		const correction = clamp((this.smoothedQueueMs - desiredMean) * 0.0005, -0.005, 0.005);
		this.rate += (1 + correction - this.rate) * (1 - Math.exp(-seconds / 0.2));
	}

	private underrun(silenceMs: number) {
		this.playing = false;
		if (this.started) {
			this.gapCount++;
			this.gapMs += silenceMs;
			this.recovering = true;
		}
		this.targetMs = clamp(Math.max(this.targetMs * 1.5, this.targetMs + 10), 5, this.limitMs);
	}

	stats(): PlaybackStats {
		return {
			queueMs: Math.max(0, (this.length - this.fraction) / FRAMES_PER_MS),
			targetMs: this.targetMs,
			rate: this.rate,
			gapCount: this.gapCount,
			gapMs: this.gapMs,
			droppedFrames: this.droppedFrames,
			maxArrivalGapMs: this.maxArrivalGapMs,
		};
	}
}
