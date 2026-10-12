import type { SharedBandOutput } from '@/worker/runtime/dsp-messages.types';

// Twelve 10ms batches cover scheduling jitter without retaining unbounded IQ.
const SLOT_COUNT = 12;

/** The channelizer owns a slot until all downstream consumers acknowledge it. */
export class SharedBandPool {
	private slots = Array.from({ length: SLOT_COUNT }, () => ({ id: 0, buffers: [] as SharedArrayBuffer[] }));
	private sequence = 0;

	copy(sources: Array<{ centerBin: number; samples: Float32Array }>): {
		batchId: number;
		bands: SharedBandOutput[];
		dropped: boolean;
	} {
		const batchId = ++this.sequence;
		const slot = this.slots.find((value) => value.id === 0);
		if (!slot) return { batchId, bands: [], dropped: true };
		slot.id = batchId;
		try {
			const bands = sources.map(({ centerBin, samples }, index) => {
				let buffer = slot.buffers[index];
				if (!buffer || buffer.byteLength < samples.byteLength) {
					buffer = new SharedArrayBuffer(2 ** Math.ceil(Math.log2(samples.byteLength)));
					slot.buffers[index] = buffer;
				}
				new Float32Array(buffer, 0, samples.length).set(samples);
				return { centerBin, buffer, length: samples.length };
			});
			return { batchId, bands, dropped: false };
		} catch (error) {
			slot.id = 0;
			throw error;
		}
	}

	release(batchId: number): void {
		const slot = this.slots.find((value) => value.id === batchId);
		if (slot) slot.id = 0;
	}
}
