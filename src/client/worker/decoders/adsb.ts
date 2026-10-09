import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { AdsbMessage, AdsbStatus } from './adsb/types';
import { AdsbDemodulator } from './adsb/demodulator';
import { AircraftTracker } from './adsb/tracker';
import { errorMessage } from '@/platform/errors';

export const ADSB_RATE = 2000000;

export class AdsbStream {
	private key = '';
	private frequency = 1090;
	private ddc?: DspProcessor;
	private direct = false;
	private scratch = new Float32Array(0);
	private lastChunk?: number;
	private tracker = new AircraftTracker();
	private demodulator = new AdsbDemodulator((frame) => this.tracker.process(frame));
	private lastEmit = 0;
	private status: AdsbStatus = { state: 'off', message: 'Decoder off', samples: 0, frames: 0 };
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: AdsbMessage) => void,
	) {}

	configure(params: VfoParams, inputRate: number, centerFreq: number): void {
		this.frequency = params.freq;
		if (!params.adsb) {
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
		if (params.freq !== 1090) {
			this.fail('Tune this VFO to 1090 MHz for ADS-B.');
			return;
		}
		if (inputRate < ADSB_RATE || Math.abs(params.freq - centerFreq) * 1e6 + ADSB_RATE / 2 > inputRate / 2) {
			this.fail('ADS-B needs a 2 MHz channel inside the received band. Increase sample rate or center the radio on 1090 MHz.');
			return;
		}
		try {
			this.direct = inputRate === ADSB_RATE;
			if (!this.direct) {
				this.ddc = new this.Processor(inputRate, (params.freq - centerFreq) * 1e6, ADSB_RATE);
				this.ddc.set_if_sample_rate(ADSB_RATE);
				this.ddc.set_bandwidth(ADSB_RATE);
			}
			this.status.state = 'receiving';
			this.status.message = 'Listening on 1090 MHz · 2 MS/s';
			this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		if (!values || this.status.state !== 'receiving') return;
		try {
			if (chunkId !== undefined && this.lastChunk !== undefined && chunkId !== this.lastChunk + 1) this.demodulator.reset();
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
		this.tracker = new AircraftTracker();
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
		this.post({ type: 'adsb', freq: this.frequency, status: { ...this.status }, aircraft: this.tracker.snapshot() });
	}
}
