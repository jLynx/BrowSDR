import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { LoraProfile, RtkMessage, RtkStatus, RtkProfile } from './types';
import { LoraReceiver } from './lora';
import { RtkTracker } from './rtcm';
import { Rtk3Tracker } from './rtk3/tracker';
import { errorMessage } from '@/platform/errors';

export const RTK_RATE = 1000000;
export const RTK_PROFILES: Record<string, LoraProfile> = {
	luba1: { bandwidth: 500000, oversample: 2, sync: [40, 36], ldro: true },
	lower: { bandwidth: 250000, oversample: 4, sync: [16, 8], ldro: false },
	// Standard private sync word 0x12 maps to SF7 symbol bins [8, 16].
	rtk3: { bandwidth: 250000, oversample: 4, sync: [8, 16], ldro: false },
};
const profileName: Record<RtkProfile, string> = {
	luba1: 'Mammotion 500 kHz profile',
	lower: 'unverified lower profile',
	rtk3: 'RTK3 / RBS03 experimental profile',
};
const initialStatus = (): RtkStatus => ({
	state: 'off',
	message: 'Decoder off',
	samples: 0,
	syncs: 0,
	headers: 0,
	payloads: 0,
	codingErrors: 0,
	packets: 0,
	crcErrors: 0,
	discontinuities: 0,
});

export class RtkStream {
	private key = '';
	private frequency = 923.118;
	private profile: RtkProfile = 'luba1';
	private ddc?: DspProcessor;
	private direct = false;
	private scratch = new Float32Array(0);
	private lastChunk?: number;
	private tracker: RtkTracker | Rtk3Tracker = new RtkTracker();
	private lora?: LoraReceiver;
	private lastEmit = 0;
	private status = initialStatus();
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: RtkMessage) => void,
	) {}
	configure(params: VfoParams, rate: number, center: number): void {
		this.frequency = params.freq;
		if (!params.rtk) {
			if (this.key) {
				this.reset();
				this.emit();
			}
			return;
		}
		const name = params.rtkProfile ?? 'luba1',
			profile = RTK_PROFILES[name];
		const ppm = params.rtkClockPpm ?? (name === 'rtk3' ? 0 : name === 'luba1' ? 20 : 10);
		const key = JSON.stringify([params.freq, rate, center, name, ppm]);
		if (this.key === key) return;
		this.reset();
		this.key = key;
		if (!profile || !Number.isFinite(ppm) || Math.abs(ppm) > 200) {
			this.fail('Choose a supported RTK profile and clock correction within ±200 ppm.');
			return;
		}
		if (
			params.freq < 900 ||
			params.freq > 930 ||
			rate < RTK_RATE ||
			Math.abs(params.freq - center) * 1e6 + profile.bandwidth * 0.6 > rate / 2
		) {
			this.fail('Tune a 900–930 MHz RTK signal inside the received band, at 1 MSPS or higher.');
			return;
		}
		try {
			this.profile = name;
			this.tracker = name === 'rtk3' ? new Rtk3Tracker() : new RtkTracker();
			this.direct = rate === RTK_RATE && Math.abs(params.freq - center) < 0.000001;
			if (!this.direct) {
				this.ddc = new this.Processor(rate, (params.freq - center) * 1e6, RTK_RATE);
				this.ddc.set_if_sample_rate(RTK_RATE);
				this.ddc.set_bandwidth(profile.bandwidth * 1.2);
			}
			this.lora = new LoraReceiver(
				profile,
				ppm,
				(packet) => this.tracker.process(packet),
				() => this.tracker.discontinuity(),
			);
			this.status.state = 'receiving';
			this.status.message = `Listening on ${params.freq.toFixed(3)} MHz · ${profileName[name]}`;
			this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}
	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		if (!values || this.status.state !== 'receiving') return;
		try {
			if (chunkId !== undefined && this.lastChunk !== undefined && chunkId !== this.lastChunk + 1) {
				this.lora?.reset();
				this.tracker.discontinuity();
				this.ddc?.reset();
				this.status.discontinuities++;
			}
			this.lastChunk = chunkId;
			this.status.samples += this.decode(ptr, values, floatInput) / 2;
			if (performance.now() - this.lastEmit >= 250) this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}
	private decode(ptr: number, values: number, floatInput: boolean): number {
		if (this.direct) {
			if (floatInput) this.lora!.process(new Float32Array(this.memory.buffer, ptr, values));
			else {
				const bytes = new Int8Array(this.memory.buffer, ptr, values);
				if (this.scratch.length < values) this.scratch = new Float32Array(values);
				for (let i = 0; i < values; i++) this.scratch[i] = bytes[i] / 128;
				this.lora!.process(this.scratch.subarray(0, values));
			}
			return values;
		}
		const output = floatInput ? this.ddc!.process_iq_only_f32_ptr(ptr, values) : this.ddc!.process_iq_only_ptr(ptr, values);
		const count = this.ddc!.get_iq_output_len();
		if (count) this.lora!.process(new Float32Array(this.memory.buffer, output, count));
		return count;
	}
	reset(): void {
		this.ddc?.free();
		this.ddc = undefined;
		this.key = '';
		this.lastChunk = undefined;
		this.lora = undefined;
		this.tracker = new RtkTracker();
		this.status = initialStatus();
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
		if (this.lora) Object.assign(this.status, this.lora.counters);
		if (this.tracker instanceof Rtk3Tracker) Object.assign(this.status, this.tracker.counters);
		this.post({
			type: 'rtk',
			freq: this.frequency,
			profile: this.profile,
			status: { ...this.status },
			stations: this.tracker.snapshot(),
			rtcm: this.tracker.flush(),
		});
	}
}
