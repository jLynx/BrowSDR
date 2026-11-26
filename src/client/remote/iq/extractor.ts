import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { SliceRequest } from './types';
import { MAX_IQ_VALUES, packIqPacket } from './packet';
import type { DspInput, DspOutput } from '@/worker/runtime/dsp-messages.types';
import { errorMessage } from '@/platform/errors';

export function emitIqSlice(
	extractor: IqSliceExtractor,
	msg: Extract<DspInput, { type: 'process' }>,
	ptr: number,
	floatInput: boolean,
	post: (message: DspOutput, transfer?: Transferable[]) => void,
): void {
	try {
		const started = performance.now();
		const packets = extractor.process(msg.slice!, msg.sampleRate!, msg.centerFreq!, ptr, msg.chunkLen, floatInput, msg.chunkId);
		post(
			{
				type: 'iq_slice',
				packets,
				index: msg.slice!.index,
				revision: msg.slice!.revision,
				chunkId: msg.chunkId,
				dspTime: performance.now() - started,
			},
			packets,
		);
	} catch (error) {
		post({ type: 'error', error: errorMessage(error), chunkId: msg.chunkId });
	} finally {
		post({ type: 'processed', chunkId: msg.chunkId });
	}
}

/** Only shifts, filters and resamples. Radio decoders are never called here. */
export class IqSliceExtractor {
	private processor?: DspProcessor;
	private key = '';
	private lastChunk?: number;
	private sequence = 0;
	constructor(
		private Processor: typeof DspProcessor,
		private memory: WebAssembly.Memory,
	) {}
	process(
		request: SliceRequest,
		rate: number,
		center: number,
		ptr: number,
		values: number,
		floatInput: boolean,
		chunkId: number,
	): ArrayBuffer[] {
		const key = JSON.stringify([request, rate, center]);
		const discontinuity = key !== this.key || (this.lastChunk !== undefined && chunkId !== this.lastChunk + 1);
		const direct = request.sampleRate === rate && request.centerFreq === center && request.bandwidth === rate;
		if (key !== this.key) {
			this.processor?.free();
			this.processor = undefined;
			if (!direct) {
				this.processor = new this.Processor(rate, (request.centerFreq - center) * 1e6, request.bandwidth);
				this.processor.set_if_sample_rate(request.sampleRate);
				this.processor.set_bandwidth(request.bandwidth);
			}
			this.key = key;
		} else if (discontinuity) this.processor?.reset();
		this.lastChunk = chunkId;
		const iq = direct
			? floatInput
				? new Float32Array(this.memory.buffer, ptr, values)
				: Float32Array.from(new Int8Array(this.memory.buffer, ptr, values), (value) => value / 128)
			: this.extract(ptr, values, floatInput);
		const count = iq.length;
		let peak = 1e-9;
		for (const value of iq) peak = Math.max(peak, Math.abs(value));
		// Scale is carried with each block so quantization does not act as an RF AGC.
		const limit = request.bits === 8 ? 127 : 32767;
		const scale = Math.min(100, peak / limit);
		const packetValues = Math.min(MAX_IQ_VALUES, Math.max(2, Math.floor(request.sampleRate * 0.02) * 2));
		const packets: ArrayBuffer[] = [];
		for (let offset = 0; offset < count; offset += packetValues) {
			const length = Math.min(packetValues, count - offset);
			const samples = request.bits === 8 ? new Int8Array(length) : new Int16Array(length);
			for (let i = 0; i < length; i++) samples[i] = Math.max(-limit, Math.min(limit, Math.round(iq[offset + i] / scale)));
			packets.push(
				packIqPacket({ ...request, samples, scale, sequence: this.sequence++ >>> 0, discontinuity: discontinuity && offset === 0 }),
			);
		}
		return packets;
	}
	private extract(ptr: number, values: number, floatInput: boolean): Float32Array {
		const processor = this.processor!;
		const outputPtr = floatInput ? processor.process_iq_only_f32_ptr(ptr, values) : processor.process_iq_only_ptr(ptr, values);
		return new Float32Array(this.memory.buffer, outputPtr, processor.get_iq_output_len());
	}
	reset(): void {
		this.processor?.free();
		this.processor = undefined;
		this.key = '';
		this.lastChunk = undefined;
	}
}
