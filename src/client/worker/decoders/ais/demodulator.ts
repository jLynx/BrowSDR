import { AisHdlc } from './hdlc';

export const AIS_RATE = 48000;

/** FM discriminator and transition-driven symbol clock for 9600-baud GMSK, at five samples per symbol. */
export class AisDemodulator {
	private previousI = 0;
	private previousQ = 0;
	private dc = 0;
	private filtered = 0;
	private phase = 0;
	private previousSign = 0;
	private previousSymbol = 0;
	private hdlc: AisHdlc;
	constructor(onFrame: (frame: Uint8Array) => void) {
		this.hdlc = new AisHdlc(onFrame);
	}
	reset(): void {
		this.previousI = this.previousQ = this.dc = this.filtered = this.phase = 0;
		this.previousSign = this.previousSymbol = 0;
		this.hdlc.reset();
	}
	process(iq: Float32Array): void {
		for (let index = 0; index + 1 < iq.length; index += 2) {
			const i = iq[index];
			const q = iq[index + 1];
			const discriminator = Math.atan2(q * this.previousI - i * this.previousQ, i * this.previousI + q * this.previousQ);
			this.previousI = i;
			this.previousQ = q;
			this.dc += 0.001 * (discriminator - this.dc);
			this.filtered += 0.5 * (discriminator - this.dc - this.filtered);
			const sign = this.filtered >= 0 ? 1 : 0;
			// Pull transitions toward the symbol boundary; sample midway between them.
			if (sign !== this.previousSign) this.phase += (this.phase < 2.5 ? -this.phase : 5 - this.phase) * 0.35;
			this.previousSign = sign;
			const before = this.phase;
			this.phase += 1;
			if (before < 2.5 && this.phase >= 2.5) {
				this.hdlc.bit(sign === this.previousSymbol ? 1 : 0);
				this.previousSymbol = sign;
			}
			if (this.phase >= 5) this.phase -= 5;
		}
	}
}
