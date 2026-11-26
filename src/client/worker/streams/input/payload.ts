import { normalize_i16_to_f32 } from '/wasm/dsp/browsdr_dsp.js';
import type { DspInput } from '@/worker/runtime/dsp-messages.types';

export function copyInputPayload(
	msg: Extract<DspInput, { type: 'process' }>,
	memory: WebAssembly.Memory,
	iqPtr: number,
	floatPtr: number,
	sabs: Int8Array[] | null,
): boolean {
	const bytes = new Int8Array(memory.buffer);
	if (msg.useSab && sabs && msg.sabIndex !== undefined) {
		bytes.set(
			sabs[msg.sabIndex].subarray(0, msg.chunkLen * (msg.iqFormat === 'float32' ? 4 : msg.iqFormat === 'int16' ? 2 : 1)),
			msg.iqFormat === 'float32' ? floatPtr : iqPtr,
		);
	} else if (msg.chunk) {
		if (msg.floatIq || msg.iqFormat === 'float32') {
			new Float32Array(memory.buffer, floatPtr, msg.chunkLen).set(new Float32Array(msg.chunk, 0, msg.chunkLen));
		} else {
			bytes.set(new Int8Array(msg.chunk, 0, msg.chunkLen * (msg.iqFormat === 'int16' ? 2 : 1)), iqPtr);
		}
	} else return false;
	if (msg.iqFormat === 'int16') normalize_i16_to_f32(iqPtr, floatPtr, msg.chunkLen);
	return true;
}
