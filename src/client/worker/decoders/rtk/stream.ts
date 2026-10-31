import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { RtkMessage } from './types';
import { RtkChannel } from './receiver/channel';
import { RtkAutoReceiver } from './receiver/auto';
import { RtkDiscoveryReceiver } from './discovery/stream';

export { RTK_RATE, RTK_PROFILES } from './receiver/profiles';

/** Manual and automatic reception share the same verified decoder/channel path. */
export class RtkStream {
	private receiver: RtkChannel | RtkAutoReceiver | RtkDiscoveryReceiver;
	private mode = 'manual';
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: RtkMessage) => void,
	) {
		this.receiver = new RtkChannel(Processor, memory, post);
	}
	configure(params: VfoParams, rate: number, center: number): void {
		const mode = params.rtkProfile === 'auto' || params.rtkProfile === 'scan' ? params.rtkProfile : 'manual';
		if (mode !== this.mode) {
			this.receiver.reset();
			this.mode = mode;
			this.receiver =
				mode === 'scan'
					? new RtkDiscoveryReceiver(this.Processor, this.memory, this.post)
					: mode === 'auto'
						? new RtkAutoReceiver(this.Processor, this.memory, this.post)
						: new RtkChannel(this.Processor, this.memory, this.post);
		}
		this.receiver.configure(params, rate, center);
	}
	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		this.receiver.process(ptr, values, floatInput, chunkId);
	}
	reset(): void {
		this.receiver.reset();
	}
	emit(): void {
		this.receiver.emit();
	}
}
