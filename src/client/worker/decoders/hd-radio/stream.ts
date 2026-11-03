import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import { RationalResampler } from '@/worker/streams/dsp-pipeline';
import { errorMessage } from '@/platform/errors';
import { HdDecoder } from './decoder';
import { HdAudioPacer } from './audio';
import { HD_BANDWIDTH, HD_IQ_RATE, emptyHdStatus, hdProgram, type HdMessage, type HdProgram, type HdStatus } from './types';

export class HdRadioStream {
	private key = '';
	private generation = 0;
	private ddc?: DspProcessor;
	private decoder?: HdDecoder;
	private status = emptyHdStatus();
	private frequency = 0;
	private lastEmit = 0;
	private sequence?: number;
	private samples = 0;
	private lastAudioSample = -Infinity;
	private left = new RationalResampler(44100, 48000);
	private right = new RationalResampler(44100, 48000);
	private audio = new HdAudioPacer();
	ready: Promise<void> = Promise.resolve();
	audioActive = false;

	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: HdMessage) => void,
	) {}

	configure(params: VfoParams, inputRate: number, center: number): void {
		this.frequency = params.freq;
		if (params.mode !== 'hdradio') {
			if (this.key) {
				this.reset();
				this.emit();
			}
			return;
		}
		const program = hdProgram(params.hdProgram);
		const key = JSON.stringify([params.freq, inputRate, center]);
		if (key === this.key) {
			if (program !== this.status.program) {
				this.status.program = program;
				this.status.frames = 0;
				this.resetAudio();
				this.emit();
			}
			return;
		}
		this.reset();
		this.key = key;
		this.status.program = program;
		if (
			!Number.isFinite(params.freq) ||
			!Number.isFinite(inputRate) ||
			inputRate < HD_IQ_RATE ||
			Math.abs(params.freq - center) * 1e6 + HD_BANDWIDTH / 2 > inputRate / 2
		) {
			this.fail(
				'HD Radio needs at least 744.188 kSPS and the full 400 kHz station inside the received band. Move the VFO closer to the center or increase the sample rate.',
			);
			return;
		}
		this.status.state = 'loading';
		this.status.message = 'Loading HD Radio…';
		this.emit();
		const generation = this.generation;
		try {
			this.ddc = new this.Processor(inputRate, (params.freq - center) * 1e6, HD_BANDWIDTH);
			this.ddc.set_if_sample_rate(HD_IQ_RATE);
			this.ddc.set_bandwidth(HD_BANDWIDTH);
		} catch (error) {
			this.fail(errorMessage(error));
			return;
		}
		const current = () => generation === this.generation;
		this.ready = HdDecoder.create({
			onNumbers: (...values) => {
				if (current()) this.onNumbers(...values);
			},
			onText: (...values) => {
				if (current()) this.onText(...values);
			},
			onAudio: (...values) => {
				if (current()) this.onAudio(...values);
			},
		})
			.then((decoder) => {
				if (!current()) {
					decoder.destroy();
					return;
				}
				this.decoder = decoder;
				this.status.state = 'searching';
				this.status.message = 'Searching for HD Radio';
				this.emit();
			})
			.catch((error: unknown) => {
				if (current()) this.fail(`HD Radio decoder failed: ${errorMessage(error)}`);
			});
	}

	process(ptr: number, values: number, floatInput: boolean, sequence: number): Float32Array | null {
		if (!this.ddc || !this.decoder || values === 0) return null;
		if (this.sequence !== undefined && sequence !== this.sequence + 1) {
			this.ddc.reset();
			this.decoder.reset();
			this.status = { ...emptyHdStatus(this.status.program), state: 'searching', message: 'Input gap · searching for HD Radio' };
			this.resetAudio();
			this.emit();
		}
		this.sequence = sequence;
		try {
			const output = floatInput ? this.ddc.process_iq_only_f32_ptr(ptr, values) : this.ddc.process_iq_only_ptr(ptr, values);
			const count = this.ddc.get_iq_output_len();
			this.samples += count / 2;
			if (count) this.decoder.process(new Float32Array(this.memory.buffer, output, count));
			if (this.samples - this.lastAudioSample > HD_IQ_RATE) this.audioActive = false;
			if (performance.now() - this.lastEmit >= 500) this.emit();
			return this.audio.read(count / 2);
		} catch (error) {
			this.fail(errorMessage(error));
			return null;
		}
	}

	reset(): void {
		this.generation++;
		this.ddc?.free();
		this.ddc = undefined;
		this.decoder?.destroy();
		this.decoder = undefined;
		this.key = '';
		this.sequence = undefined;
		this.samples = 0;
		this.status = emptyHdStatus();
		this.resetAudio();
	}

	private resetAudio(): void {
		this.audio = new HdAudioPacer();
		this.left = new RationalResampler(44100, 48000);
		this.right = new RationalResampler(44100, 48000);
		this.audioActive = false;
		this.lastAudioSample = -Infinity;
	}

	private program(index: number): HdProgram {
		let program = this.status.programs.find((entry) => entry.program === index);
		if (!program) {
			program = { program: index, title: '', artist: '', album: '', genre: '' };
			this.status.programs.push(program);
			this.status.programs.sort((a, b) => a.program - b.program);
		}
		return program;
	}

	private onNumbers(type: number, program: number, a: number, b: number): void {
		if (type === 0) {
			this.status.state = 'locked';
			this.status.message = 'Digital signal locked';
			this.emit();
		}
		if (type === 1) {
			this.status.state = 'searching';
			this.status.message = 'Digital signal lost · searching';
			delete this.status.ber;
			delete this.status.merLower;
			delete this.status.merUpper;
			// RF lock describes incoming symbols, not the delayed PCM already in
			// nrsc5's elastic buffer. Keep that audio and its resampler continuous.
			this.emit();
		}
		if (type === 2 && Number.isFinite(a)) this.status.ber = a;
		if (type === 3 && Number.isFinite(a) && Number.isFinite(b)) {
			this.status.merLower = a;
			this.status.merUpper = b;
		}
		if (type === 4 && program >= 0 && program <= 7) {
			Object.assign(this.program(program), { type: a, restricted: b !== 0 });
		}
	}

	private onText(type: number, program: number, a: string, b: string, c: string, d: string): void {
		if (type === 0 && program >= 0 && program <= 7) Object.assign(this.program(program), { title: a, artist: b, album: c, genre: d });
		if (type === 1) this.status.station = a;
		if (type === 2) this.status.slogan = a;
		if (type === 3) this.status.stationMessage = a;
	}

	private onAudio(program: number, pcm: Int16Array, flags: number): void {
		if (program !== this.status.program) return;
		if (flags === 0) {
			this.status.frames++;
			this.audioActive = true;
			this.lastAudioSample = this.samples;
			this.program(program);
		}
		const count = pcm.length / 2;
		const l = new Float32Array(count),
			r = new Float32Array(count);
		for (let i = 0; i < count; i++) {
			l[i] = pcm[i * 2] / 32768;
			r[i] = pcm[i * 2 + 1] / 32768;
		}
		const left = this.left.process(l),
			right = this.right.process(r);
		const output = new Float32Array(left.length * 2);
		for (let i = 0; i < left.length; i++) {
			output[i * 2] = Math.max(-1, Math.min(1, left[i]));
			output[i * 2 + 1] = Math.max(-1, Math.min(1, right[i]));
		}
		this.audio.push(output);
	}

	private fail(message: string): void {
		const key = this.key,
			program = this.status.program;
		this.reset();
		this.key = key;
		this.status = { ...emptyHdStatus(program), state: 'error', message };
		this.emit();
	}
	private emit(): void {
		this.lastEmit = performance.now();
		const status: HdStatus = { ...this.status, programs: this.status.programs.map((program) => ({ ...program })) };
		this.post({ type: 'hd_radio', freq: this.frequency, status });
	}
}
