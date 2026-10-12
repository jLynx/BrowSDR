import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { BleAdvertisement, BleMessage, BleStatus } from './types';
import { BLE_CHANNELS, BLE_RATE } from './packets';
import { BleDemodulator } from './demodulator';
import { errorMessage } from '@/platform/errors';

export class BleStream {
	private key = '';
	private frequency = 2402;
	private ddc?: DspProcessor;
	private demodulator?: BleDemodulator;
	private scratch = new Float32Array(0);
	private lastChunk?: number;
	private pending: BleAdvertisement[] = [];
	private lastEmit = 0;
	private status: BleStatus = { state: 'off', message: 'Decoder off', samples: 0, frames: 0 };
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: BleMessage) => void,
	) {}

	configure(params: VfoParams, rate: number, center: number): void {
		this.frequency = params.freq;
		if (!params.ble) {
			if (this.key) {
				this.reset();
				this.emit();
			}
			return;
		}
		const key = JSON.stringify([params.freq, rate, center]);
		if (key === this.key) return;
		this.reset();
		this.key = key;
		const channel = BLE_CHANNELS.find((item) => Math.abs(item.frequency - params.freq) < 0.000001);
		if (!channel) {
			this.fail('Tune to BLE advertising channel 37 (2402), 38 (2426), or 39 (2480 MHz).');
			return;
		}
		if (
			!Number.isFinite(rate) ||
			!Number.isFinite(center) ||
			rate < BLE_RATE ||
			Math.abs(params.freq - center) * 1e6 + BLE_RATE / 2 > rate / 2
		) {
			this.fail('BLE needs a 2 MHz channel inside the received band. Increase sample rate or center the receiver on this channel.');
			return;
		}
		try {
			this.demodulator = new BleDemodulator(channel.channel, (packet) => {
				this.status.frames++;
				if (this.pending.length < 256) this.pending.push(packet);
			});
			if (rate !== BLE_RATE || Math.abs(params.freq - center) >= 0.000001) {
				this.ddc = new this.Processor(rate, (params.freq - center) * 1e6, BLE_RATE);
				this.ddc.set_if_sample_rate(BLE_RATE);
				this.ddc.set_bandwidth(1800000);
			}
			this.status.state = 'receiving';
			this.status.message = `Listening on channel ${channel.channel} · ${params.freq} MHz`;
			this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	process(ptr: number, values: number, float: boolean, chunkId?: number): void {
		if (!values || this.status.state !== 'receiving') return;
		try {
			if (chunkId !== undefined && this.lastChunk !== undefined && chunkId !== this.lastChunk + 1) {
				this.demodulator!.reset();
				this.ddc?.reset();
			}
			this.lastChunk = chunkId;
			let input: Float32Array;
			if (this.ddc) {
				const output = float ? this.ddc.process_iq_only_f32_ptr(ptr, values) : this.ddc.process_iq_only_ptr(ptr, values);
				input = new Float32Array(this.memory.buffer, output, this.ddc.get_iq_output_len());
			} else if (float) input = new Float32Array(this.memory.buffer, ptr, values);
			else {
				const bytes = new Int8Array(this.memory.buffer, ptr, values);
				if (this.scratch.length < values) this.scratch = new Float32Array(values);
				for (let i = 0; i < values; i++) this.scratch[i] = bytes[i] / 128;
				input = this.scratch.subarray(0, values);
			}
			this.demodulator!.process(input);
			this.status.samples += input.length / 2;
			if (performance.now() - this.lastEmit >= 250 || this.pending.length >= 256) this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	reset(): void {
		this.ddc?.free();
		this.ddc = undefined;
		this.demodulator = undefined;
		this.key = '';
		this.lastChunk = undefined;
		this.pending = [];
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
		this.post({ type: 'ble', freq: this.frequency, status: { ...this.status }, advertisements: this.pending });
		this.pending = [];
	}
}
