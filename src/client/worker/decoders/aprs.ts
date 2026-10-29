import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { AprsMessage, AprsStatus } from './aprs/types';
import { AprsDemodulator, APRS_RATE } from './aprs/demodulator';
import { AprsTracker } from './aprs/tracker';
import { errorMessage } from '@/platform/errors';

export { APRS_RATE };
export const APRS_CHANNELS = [
	{ frequency: 144.39, region: 'North America' },
	{ frequency: 144.8, region: 'Europe / Africa' },
	{ frequency: 145.175, region: 'Australia' },
	{ frequency: 144.575, region: 'New Zealand' },
	{ frequency: 144.66, region: 'Japan' },
	{ frequency: 145.57, region: 'Brazil' },
	{ frequency: 145.825, region: 'ISS / satellites' },
];
// 1200-baud AFSK packet is used on the 6 m, 2 m, 1.25 m and 70 cm amateur bands.
const APRS_BANDS = [
	[50, 54],
	[144, 148],
	[222, 225],
	[420, 450],
];
export const isAprsFrequency = (frequency: number): boolean =>
	Number.isFinite(frequency) && APRS_BANDS.some(([low, high]) => frequency >= low && frequency <= high);

export class AprsStream {
	private key = '';
	private frequency = 144.39;
	private ddc?: DspProcessor;
	private direct = false;
	private scratch = new Float32Array(0);
	private lastChunk?: number;
	private tracker = new AprsTracker();
	private changed = false;
	private demodulator = new AprsDemodulator((frame) => {
		if (this.tracker.process(frame)) this.changed = true;
	});
	private lastEmit = 0;
	private status: AprsStatus = { state: 'off', message: 'Decoder off', samples: 0, frames: 0 };
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: AprsMessage) => void,
	) {}

	configure(params: VfoParams, inputRate: number, centerFreq: number): void {
		this.frequency = params.freq;
		if (!params.aprs) {
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
		if (!isAprsFrequency(params.freq)) {
			this.fail('Tune this VFO to an amateur VHF/UHF packet channel, such as APRS on 144.390 or 144.800 MHz.');
			return;
		}
		if (inputRate < APRS_RATE || Math.abs(params.freq - centerFreq) * 1e6 + APRS_RATE / 2 > inputRate / 2) {
			this.fail('APRS needs a 48 kHz channel inside the received band. Increase sample rate or center the radio near the APRS channel.');
			return;
		}
		try {
			this.direct = inputRate === APRS_RATE && Math.abs(params.freq - centerFreq) < 0.000001;
			if (!this.direct) {
				this.ddc = new this.Processor(inputRate, (params.freq - centerFreq) * 1e6, APRS_RATE);
				this.ddc.set_if_sample_rate(APRS_RATE);
				// ±8 kHz passes 5 kHz deviation with the 2200 Hz tone and typical transmitter frequency error.
				this.ddc.set_bandwidth(16000);
			}
			this.status.state = 'receiving';
			this.status.message = `Listening on ${params.freq.toFixed(3)} MHz · AFSK 1200`;
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
			// Snapshots carry the packet log, so idle channels refresh their counters once per second.
			const elapsed = performance.now() - this.lastEmit;
			if ((this.changed && elapsed >= 250) || elapsed >= 1000) this.emit();
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
		this.tracker = new AprsTracker();
		this.changed = false;
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
		this.changed = false;
		this.status.frames = this.tracker.frames;
		this.post({ type: 'aprs', freq: this.frequency, status: { ...this.status }, ...this.tracker.snapshot() });
	}
}
