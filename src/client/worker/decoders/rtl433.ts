import type { Rtl433Message, Rtl433Protocol, Rtl433Status, RtlModule, RtlFactory } from './types';
import { errorMessage } from '@/platform/errors';
import type { VfoParams } from '@/worker/runtime/types';
import type { DspProcessor } from '/hackrf-web/pkg/hackrf_web.js';
import { isRecord } from '@/platform/data';

export function rtl433SampleRate(value: unknown): number {
	return [250000, 500000, 1000000].includes(Number(value)) ? Number(value) : 250000;
}

export function rtl433ProtocolIds(value: unknown): string {
	const text = (typeof value === 'string' || typeof value === 'number' ? String(value) : '').trim();
	if (!text) return '';
	if (!/^\d+(\s*,\s*\d+)*$/.test(text)) throw new Error('Use protocol numbers separated by commas, or leave blank for default protocols.');
	const ids = [...new Set(text.split(',').map(Number))];
	if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('Protocol numbers must be positive integers.');
	return ids.join(',');
}

let factoryPromise: Promise<RtlFactory> | undefined;
async function loadFactory(): Promise<RtlFactory> {
	// Load the committed Emscripten ES module as a static asset in dev and production.
	// Absolute HTTP URLs bypass Vite's source-import query rewriting for public assets.
	const url = typeof location === 'undefined' ? '/lib/rtl433/rtl433.js' : new URL('/lib/rtl433/rtl433.js', location.origin).href;
	factoryPromise ??= import(/* @vite-ignore */ url)
		.then((module: unknown) => {
			if (!isRecord(module) || typeof module.default !== 'function') throw new Error('Missing rtl_433 factory');
			return module.default as RtlFactory;
		})
		.catch((error) => {
			factoryPromise = undefined;
			throw new Error(`Could not load rtl_433. Restore public/lib/rtl433 assets or rebuild the decoder. ${errorMessage(error)}`);
		});
	return factoryPromise;
}

export class Rtl433Decoder {
	private ptr = 0;
	private capacity = 0;
	private constructor(
		private module: RtlModule,
		readonly protocols: Rtl433Protocol[],
		readonly activeProtocols: number,
	) {}

	static async create(
		rate: number,
		frequencyHz: number,
		ids: string,
		onEvent: (event: Record<string, unknown>) => void,
	): Promise<Rtl433Decoder> {
		const factory = await loadFactory();
		const module: RtlModule = await factory({
			locateFile: (path: string) => '/lib/rtl433/' + path,
			onDecoded: (json: string) => {
				const event: unknown = JSON.parse(json);
				if (isRecord(event)) onEvent(event);
			},
			print: () => {},
			printErr: () => {},
		});
		const idsPtr = module.stringToNewUTF8(ids);
		let active: number;
		try {
			active = module._rtl433_init(rate, frequencyHz, idsPtr);
		} finally {
			module._free(idsPtr);
		}
		const protocols = Array.from({ length: module._rtl433_protocol_count() }, (_, index) => ({
			id: index + 1,
			name: module.UTF8ToString(module._rtl433_protocol_name(index + 1)),
			disabled: module._rtl433_protocol_disabled(index + 1) !== 0,
		}));
		if (
			!active ||
			ids
				.split(',')
				.filter(Boolean)
				.some((id) => Number(id) > protocols.length)
		) {
			module._rtl433_destroy();
			throw new Error(`Choose protocol numbers between 1 and ${protocols.length}.`);
		}
		return new Rtl433Decoder(module, protocols, active);
	}

	process(iq: Float32Array): void {
		if (iq.length % 2) throw new Error('rtl_433 requires interleaved I/Q pairs.');
		// Bound every copy, including high-rate recorded input, to 32K complex samples.
		for (let offset = 0; offset < iq.length; offset += 65536) {
			const block = iq.subarray(offset, offset + 65536);
			if (block.length > this.capacity) {
				if (this.ptr) this.module._free(this.ptr);
				this.ptr = this.module._malloc(block.byteLength);
				if (!this.ptr) throw new Error('rtl_433 could not allocate its IQ buffer.');
				this.capacity = block.length;
			}
			this.module.HEAPF32.set(block, this.ptr / 4);
			this.module._rtl433_process(this.ptr, block.length);
		}
	}

	flush(): void {
		this.module._rtl433_flush();
	}
	destroy(): void {
		if (this.ptr) this.module._free(this.ptr);
		this.ptr = 0;
		this.capacity = 0;
		this.module._rtl433_destroy();
	}
}

/** Synchronous DSP with asynchronous, generation-guarded decoder loading. */
export class Rtl433Stream {
	private key = '';
	private generation = 0;
	private ddc?: DspProcessor;
	private decoder?: Rtl433Decoder;
	private status: Rtl433Status = { state: 'off', message: 'Decoder off', sampleRate: 250000, samples: 0, events: 0 };
	private lastStatusTime = 0;
	private frequency?: number;
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: Rtl433Message) => void,
	) {}

	configure(params: VfoParams, inputRate: number, centerFreq: number): void {
		this.frequency = params.freq;
		if (!params.rtl433) {
			if (this.key || this.status.state !== 'off') {
				this.reset();
				this.emit();
			}
			return;
		}
		let ids: string;
		try {
			ids = rtl433ProtocolIds(params.rtl433Protocols);
		} catch (error) {
			const invalidKey = `invalid:${params.rtl433Protocols}`;
			if (this.key !== invalidKey) {
				this.key = invalidKey;
				this.fail(errorMessage(error));
			}
			return;
		}
		const rate = rtl433SampleRate(params.rtl433SampleRate);
		const key = JSON.stringify([params.freq, inputRate, centerFreq, rate, ids]);
		if (key === this.key) return;
		this.reset();
		this.key = key;
		if (!Number.isFinite(params.freq) || rate > inputRate || Math.abs(params.freq - centerFreq) * 1e6 + rate * 0.4 > inputRate / 2) {
			this.fail('Decoder bandwidth is outside the received band. Increase the radio sample rate or move the VFO closer to the center.');
			return;
		}
		const generation = this.generation;
		this.status = { state: 'loading', message: 'Loading rtl_433…', sampleRate: rate, samples: 0, events: 0 };
		this.emit();
		try {
			this.ddc = new this.Processor(inputRate, (params.freq - centerFreq) * 1e6, rate * 0.8);
			this.ddc.set_if_sample_rate(rate);
			this.ddc.set_bandwidth(rate * 0.8);
		} catch (error) {
			this.fail(errorMessage(error));
			return;
		}
		Rtl433Decoder.create(rate, Math.round(params.freq * 1e6), ids, (event) => {
			if (generation !== this.generation) return;
			this.status.events++;
			this.post({ type: 'rtl433_event', freq: params.freq, event });
		})
			.then((decoder) => {
				if (generation !== this.generation) {
					decoder.destroy();
					return;
				}
				this.decoder = decoder;
				this.status = {
					...this.status,
					state: 'receiving',
					message: `Listening · ${decoder.activeProtocols} protocols`,
					protocols: decoder.protocols,
				};
				this.emit();
				delete this.status.protocols;
			})
			.catch((error) => {
				if (generation === this.generation) this.fail(errorMessage(error));
			});
	}

	process(ptr: number, values: number, floatInput: boolean): void {
		// Empty DDC calls retain the previous IQ output; they do not flush it.
		if (values === 0 || !this.decoder || !this.ddc) return;
		try {
			const out = floatInput ? this.ddc.process_iq_only_f32_ptr(ptr, values) : this.ddc.process_iq_only_ptr(ptr, values);
			const count = this.ddc.get_iq_output_len();
			if (count) {
				this.decoder.process(new Float32Array(this.memory.buffer, out, count));
				this.status.samples += count / 2;
			}
			if (performance.now() - this.lastStatusTime > 1000) this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	reset(): void {
		this.generation++;
		this.ddc?.free();
		this.ddc = undefined;
		this.decoder?.destroy();
		this.decoder = undefined;
		this.key = '';
		this.status = { state: 'off', message: 'Decoder off', sampleRate: 250000, samples: 0, events: 0 };
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
		this.lastStatusTime = performance.now();
		this.post({ type: 'rtl433_status', freq: this.frequency, status: { ...this.status } });
	}
}
