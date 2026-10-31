import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { IqInput } from './types';
import { RTK_RATE } from './profiles';

/** Share the full-rate DDC while trying both LoRa bandwidths at the tuned VFO. */
export class RtkAcquisition {
	private ddc?: DspProcessor;
	constructor(private Processor: typeof DspProcessor) {}
	configure(rate: number, center: number, frequency: number): void {
		if (frequency < 900 || frequency > 930 || rate < RTK_RATE || Math.abs(frequency - center) * 1e6 + 150000 > rate / 2)
			throw new Error('Tune a 900–930 MHz RTK signal inside the received band, at 1 MSPS or higher.');
		if (rate === RTK_RATE && Math.abs(frequency - center) < 0.000001) return;
		this.ddc = new this.Processor(rate, (frequency - center) * 1e6, RTK_RATE);
		this.ddc.set_if_sample_rate(RTK_RATE);
		this.ddc.set_bandwidth(600000);
	}
	process(ptr: number, values: number, floatInput: boolean): IqInput {
		if (!this.ddc) return { ptr, values, floatInput };
		const output = floatInput ? this.ddc.process_iq_only_f32_ptr(ptr, values) : this.ddc.process_iq_only_ptr(ptr, values);
		return { ptr: output, values: this.ddc.get_iq_output_len(), floatInput: true };
	}
	discontinuity(): void {
		this.ddc?.reset();
	}
	/** Transfer the already allocated full-rate filter to the selected decoder. */
	take(): DspProcessor | undefined {
		const ddc = this.ddc;
		this.ddc = undefined;
		return ddc;
	}
	free(): void {
		this.ddc?.free();
		this.ddc = undefined;
	}
}
