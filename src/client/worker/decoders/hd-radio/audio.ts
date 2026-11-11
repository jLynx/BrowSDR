import { HD_IQ_RATE } from './types';

const AUDIO_RATE = 48000;
const START_FRAMES = AUDIO_RATE * 0.1;
const MAX_FRAMES = AUDIO_RATE * 0.5;

/** Convert nrsc5's 93ms PCM bursts to the cadence of the incoming IQ. */
export class HdAudioPacer {
	private blocks: Float32Array[] = [];
	private offset = 0;
	private frames = 0;
	private playing = false;
	private fraction = 0;

	push(stereo: Float32Array): void {
		if (!stereo.length) return;
		this.blocks.push(stereo);
		this.frames += stereo.length / 2;
		if (this.frames > MAX_FRAMES) this.consume(this.frames - MAX_FRAMES);
	}

	read(iqSamples: number): Float32Array | null {
		if (!this.playing && this.frames >= START_FRAMES) this.playing = true;
		if (!this.playing) return null;
		const desired = (iqSamples * AUDIO_RATE) / HD_IQ_RATE + this.fraction;
		const frames = Math.min(Math.floor(desired), this.frames);
		this.fraction = desired - Math.floor(desired);
		if (!frames) {
			if (Math.floor(desired) > 0) {
				this.playing = false;
				this.fraction = 0;
			}
			return null;
		}
		const result = new Float32Array(frames * 2);
		this.consume(frames, result);
		if (frames < Math.floor(desired)) {
			this.playing = false;
			this.fraction = 0;
		}
		return result;
	}

	private consume(frames: number, output?: Float32Array): void {
		let written = 0;
		while (frames > 0) {
			const block = this.blocks[0];
			const count = Math.min(frames * 2, block.length - this.offset);
			output?.set(block.subarray(this.offset, this.offset + count), written);
			written += count;
			this.offset += count;
			this.frames -= count / 2;
			frames -= count / 2;
			if (this.offset === block.length) {
				this.blocks.shift();
				this.offset = 0;
			}
		}
	}
}
