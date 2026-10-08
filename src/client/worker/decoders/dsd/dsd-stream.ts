import { RationalResampler } from '../../streams/dsp-pipeline';
import { DSDDecoder } from './dsd-decoder';
import { FMDiscriminator } from './dsd-dsp';
import { DSD_AUDIO_RATE, DSD_IF_RATE } from './types';
import type { DSDStatus } from './types';

/** Turns bursty codec output into audio paced by the received IQ clock. */
export class DSDStream {
	private decoder: DSDDecoder;
	private discriminator = new FMDiscriminator();
	private resampler = new RationalResampler(DSD_AUDIO_RATE, DSD_IF_RATE);
	private queue = new Float32Array(DSD_IF_RATE);
	private readPos = 0;
	private queued = 0;
	private configuration = '';
	private squelched = false;
	/** True only for chunks playing decoded voice from the FIFO. */
	audioActive = false;

	constructor(onStatus: (status: DSDStatus) => void) {
		this.decoder = new DSDDecoder(
			(audio) => {
				const resampled = this.resampler.process(audio);
				for (const sample of resampled) {
					// Bound latency if a damaged frame produces too much audio.
					if (this.queued === this.queue.length) {
						this.readPos = (this.readPos + 1) % this.queue.length;
						this.queued--;
					}
					this.queue[(this.readPos + this.queued++) % this.queue.length] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
				}
			},
			(status) => {
				if (!status.synced) {
					this.readPos = 0;
					this.queued = 0;
				}
				onStatus(status);
			},
		);
	}

	configure(freq: number, bandwidth: number, enabled: boolean, sourceRate: number): void {
		const configuration = `${freq}/${bandwidth}/${enabled}/${sourceRate}`;
		if (configuration !== this.configuration) {
			this.configuration = configuration;
			this.reset();
		}
	}

	process(iq: Float32Array, squelched = false): Float32Array {
		this.audioActive = false;
		const output = new Float32Array(iq.length / 2);
		if (squelched) {
			if (!this.squelched) this.reset();
			this.squelched = true;
			return output;
		}
		this.squelched = false;
		const fmAudio = new Float32Array(output.length);
		this.discriminator.process(iq, fmAudio);
		this.decoder.process(fmAudio);
		const count = Math.min(output.length, this.queued);
		this.audioActive = count > 0;
		for (let i = 0; i < count; i++) {
			output[i] = this.queue[this.readPos];
			this.readPos = (this.readPos + 1) % this.queue.length;
		}
		this.queued -= count;
		return output;
	}

	reset(): void {
		this.audioActive = false;
		this.decoder.reset();
		this.discriminator.reset();
		this.resampler = new RationalResampler(DSD_AUDIO_RATE, DSD_IF_RATE);
		this.readPos = 0;
		this.queued = 0;
		this.squelched = false;
	}
}
