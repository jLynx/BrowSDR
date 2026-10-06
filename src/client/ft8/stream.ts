import { RationalResampler } from '../worker/dsp-pipeline';

/** Align continuous pre-volume audio to complete UTC 15-second receive slots. */
export class FT8Stream {
	private resampler = new RationalResampler(48000, 12000);
	private frame = new Float32Array(180000);
	private slot = -1;
	private position = 0;
	private nextSample = 0;
	private aligned = false;
	private complete = false;
	constructor(private onFrame: (audio: Float32Array, slot: number) => void) {}

	push(audio: Float32Array, endTime: number): void {
		const samples = this.resampler.process(audio);
		const start = Math.round(endTime * 12) - samples.length;
		// USB audio arrives in bursts. Small timestamp jitter must not insert gaps
		// or stretch tones; a real interruption invalidates the current slot.
		if (!this.aligned || Math.abs(start - this.nextSample) > 9000) {
			this.nextSample = start;
			this.slot = -1;
			this.complete = false;
			this.aligned = true;
		}
		for (let offset = 0; offset < samples.length;) {
			const slot = Math.floor(this.nextSample / 180000);
			const position = this.nextSample - slot * 180000;
			if (slot !== this.slot) {
				this.slot = slot;
				this.frame.fill(0);
				this.complete = position === 0;
			}
			const count = Math.min(samples.length - offset, 180000 - position);
			this.frame.set(samples.subarray(offset, offset + count), position);
			this.position = position + count;
			this.nextSample += count;
			offset += count;
			if (this.position === 180000 && this.complete) this.onFrame(this.frame.slice(), slot * 15000);
		}
	}
	get progress(): number { return this.position / 180000; }
	get collecting(): boolean { return this.complete; }
}
