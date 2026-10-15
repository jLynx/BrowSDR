export const RECORDING_SAMPLE_RATE = 48000;
export const MAX_RECORDING_SECONDS = 300;

/** Fixed stereo PCM preserves channel changes without resampling the signal. */
export class WavRecording {
	private chunks: Array<Uint8Array<ArrayBuffer>> = [];
	frames = 0;

	append(samples: Float32Array, channels: 1 | 2) {
		const frames = Math.min(samples.length / channels, MAX_RECORDING_SECONDS * RECORDING_SAMPLE_RATE - this.frames);
		const bytes = new Uint8Array(frames * 4);
		const view = new DataView(bytes.buffer);
		for (let frame = 0; frame < frames; frame++) {
			for (let channel = 0; channel < 2; channel++) {
				const value = samples[frame * channels + (channels === 1 ? 0 : channel)];
				const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
				view.setInt16(frame * 4 + channel * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
			}
		}
		if (frames) this.chunks.push(bytes);
		this.frames += frames;
		return this.frames >= MAX_RECORDING_SECONDS * RECORDING_SAMPLE_RATE;
	}

	get seconds() {
		return this.frames / RECORDING_SAMPLE_RATE;
	}

	finish() {
		const header = new ArrayBuffer(44);
		const view = new DataView(header);
		const write = (offset: number, value: string) => {
			for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
		};
		write(0, 'RIFF');
		view.setUint32(4, 36 + this.frames * 4, true);
		write(8, 'WAVE');
		write(12, 'fmt ');
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 2, true);
		view.setUint32(24, RECORDING_SAMPLE_RATE, true);
		view.setUint32(28, RECORDING_SAMPLE_RATE * 4, true);
		view.setUint16(32, 4, true);
		view.setUint16(34, 16, true);
		write(36, 'data');
		view.setUint32(40, this.frames * 4, true);
		const blob = new Blob([header, ...this.chunks], { type: 'audio/wav' });
		this.chunks = [];
		return blob;
	}
}
