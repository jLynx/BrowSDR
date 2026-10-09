import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { AcarsMessage, AcarsStatus } from './acars/types';
import { AcarsDemodulator, ACARS_RATE } from './acars/demodulator';
import { AcarsLog } from './acars/tracker';
import { errorMessage } from '@/platform/errors';

export { ACARS_RATE };
export const ACARS_CHANNELS = [131.55, 131.45, 131.725, 131.525, 130.025, 129.125, 130.45, 131.125, 131.65];
export const isAcarsFrequency = (frequency: number): boolean => Number.isFinite(frequency) && frequency >= 118 && frequency <= 137;

export class AcarsStream {
	private key = '';
	private frequency = 131.55;
	private ddc?: DspProcessor;
	private direct = false;
	private scratch = new Float32Array(0);
	private lastChunk?: number;
	private tracker = new AcarsLog();
	private demodulator = new AcarsDemodulator((frame) => this.tracker.process(frame));
	private lastEmit = 0;
	private status: AcarsStatus = { state: 'off', message: 'Decoder off', samples: 0, frames: 0 };
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: AcarsMessage) => void,
	) {}

	configure(params: VfoParams, inputRate: number, centerFreq: number): void {
		this.frequency = params.freq;
		if (!params.acars) {
			if (this.key) {
				this.reset();
				this.emit();
			}
			return;
		}
		const key = JSON.stringify([params.freq, inputRate, centerFreq]);
		if (key === this.key) return;
		this.reset();
		this.key = key;
		if (!isAcarsFrequency(params.freq)) {
			this.fail('Tune this VFO to a VHF ACARS channel between 118 and 137 MHz.');
			return;
		}
		if (inputRate < ACARS_RATE || Math.abs(params.freq - centerFreq) * 1e6 + ACARS_RATE / 2 > inputRate / 2) {
			this.fail('ACARS needs a 48 kHz channel inside the received band. Increase sample rate or center the radio near the ACARS channel.');
			return;
		}
		try {
			this.direct = inputRate === ACARS_RATE && Math.abs(params.freq - centerFreq) < 0.000001;
			if (!this.direct) {
				this.ddc = new this.Processor(inputRate, (params.freq - centerFreq) * 1e6, ACARS_RATE);
				this.ddc.set_if_sample_rate(ACARS_RATE);
				this.ddc.set_bandwidth(25000);
			}
			this.status.state = 'receiving';
			this.status.message = `Listening on ${params.freq.toFixed(3)} MHz - VHF ACARS`;
			this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		if (!values || this.status.state !== 'receiving') return;
		try {
			if (chunkId !== undefined && this.lastChunk !== undefined && chunkId !== this.lastChunk + 1) {
				this.demodulator.reset();
				this.ddc?.reset();
			}
			this.lastChunk = chunkId;
			const count = this.decodeInput(ptr, values, floatInput);
			this.status.samples += count / 2;
			if (performance.now() - this.lastEmit >= 250) this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	private decodeInput(ptr: number, values: number, floatInput: boolean): number {
		if (this.direct) {
			if (floatInput) this.demodulator.process(new Float32Array(this.memory.buffer, ptr, values));
			else {
				const bytes = new Int8Array(this.memory.buffer, ptr, values);
				if (this.scratch.length < values) this.scratch = new Float32Array(values);
				for (let i = 0; i < values; i++) this.scratch[i] = bytes[i] / 128;
				this.demodulator.process(this.scratch.subarray(0, values));
			}
			return values;
		}
		const output = floatInput ? this.ddc!.process_iq_only_f32_ptr(ptr, values) : this.ddc!.process_iq_only_ptr(ptr, values);
		const count = this.ddc!.get_iq_output_len();
		if (count) this.demodulator.process(new Float32Array(this.memory.buffer, output, count));
		return count;
	}

	reset(): void {
		this.ddc?.free();
		this.ddc = undefined;
		this.key = '';
		this.lastChunk = undefined;
		this.tracker = new AcarsLog();
		this.demodulator.reset();
		this.status = { state: 'off', message: 'Decoder off', samples: 0, frames: 0 };
	}
	private fail(message: string): void {
		const key = this.key;
		this.reset();
		this.key = key;
		this.status.state = 'error';
		this.status.message = message;
		this.emit();
	}
	private emit(): void {
		this.lastEmit = performance.now();
		this.status.frames = this.tracker.frames;
		this.post({ type: 'acars', freq: this.frequency, status: { ...this.status }, messages: this.tracker.snapshot() });
	}
}
