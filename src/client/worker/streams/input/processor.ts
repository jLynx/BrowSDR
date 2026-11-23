import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';

/** Apply source-specific DC handling to every decoder's independent DDC. */
export function createInputProcessor(Base: typeof DspProcessor) {
	let preserveDc = false;
	return {
		Processor: class extends Base {
			constructor(rate: number, offset: number, bandwidth: number) {
				super(rate, offset, bandwidth);
				this.set_dc_block_enabled?.(!preserveDc);
			}
		},
		setPreserveDc(enabled: boolean): boolean {
			const changed = preserveDc !== enabled;
			preserveDc = enabled;
			return changed;
		},
	};
}
