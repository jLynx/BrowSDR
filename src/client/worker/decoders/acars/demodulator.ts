import { AcarsFramer } from './framing';

export const ACARS_RATE = 48000;
const SYMBOL_SAMPLES = ACARS_RATE / 2400;

// AM envelope -> 1200/2400 Hz MSK tones. Sliding quadrature correlations
// evaluate every symbol phase; differential decisions remove carrier phase.
// A 2400 Hz symbol preserves the data bit and 1200 Hz changes it.
export class AcarsDemodulator {
	private dc = 0;
	private sample = 0;
	private sums = new Float64Array(4);
	private ring = new Float64Array(SYMBOL_SAMPLES * 4);
	private carriers = new Float64Array(SYMBOL_SAMPLES * 2 * 4);
	private previous = new Uint8Array(SYMBOL_SAMPLES);
	private framers: AcarsFramer[];
	private lastFrame = '';
	private lastFrameSample = -Infinity;
	constructor(onFrame: (frame: Uint8Array) => void) {
		this.framers = Array.from(
			{ length: SYMBOL_SAMPLES },
			() =>
				new AcarsFramer((frame) => {
					const key = Array.from(frame).join(',');
					if (key === this.lastFrame && this.sample - this.lastFrameSample <= SYMBOL_SAMPLES * 2) return;
					this.lastFrame = key;
					this.lastFrameSample = this.sample;
					onFrame(frame);
				}),
		);
		for (let i = 0; i < SYMBOL_SAMPLES * 2; i++) {
			const angle = (2 * Math.PI * 1200 * i) / ACARS_RATE;
			this.carriers.set([Math.cos(angle), Math.sin(angle), Math.cos(angle * 2), Math.sin(angle * 2)], i * 4);
		}
	}
	reset(): void {
		this.dc = this.sample = 0;
		this.sums.fill(0);
		this.ring.fill(0);
		this.previous.fill(0);
		this.lastFrame = '';
		this.lastFrameSample = -Infinity;
		for (const framer of this.framers) framer.reset();
	}
	process(iq: Float32Array): void {
		for (let i = 0; i + 1 < iq.length; i += 2) {
			const envelope = Math.hypot(iq[i], iq[i + 1]);
			this.dc += 0.001 * (envelope - this.dc);
			const audio = envelope - this.dc;
			const lane = this.sample % SYMBOL_SAMPLES;
			const carrier = (this.sample % (SYMBOL_SAMPLES * 2)) * 4;
			for (let j = 0; j < 4; j++) {
				const index = lane * 4 + j;
				const value = audio * this.carriers[carrier + j];
				this.sums[j] += value - this.ring[index];
				this.ring[index] = value;
			}
			if (this.sample >= SYMBOL_SAMPLES) {
				const low = this.sums[0] ** 2 + this.sums[1] ** 2;
				const high = this.sums[2] ** 2 + this.sums[3] ** 2;
				this.previous[lane] ^= low > high ? 1 : 0;
				this.framers[lane].bit(this.previous[lane]);
			}
			this.sample++;
		}
	}
}
