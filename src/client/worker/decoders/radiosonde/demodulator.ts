import { Rs41Framer } from './framing';

export const RADIOSONDE_RATE = 48000;

/** FM discriminator with ten parallel symbol phases for RS41's 4800-baud FSK. */
export class RadiosondeDemodulator {
	private previousI = 0;
	private previousQ = 0;
	private dc = 0;
	private window = new Float64Array(10);
	private sum = 0;
	private index = 0;
	private framers: Rs41Framer[];
	constructor(onFrame: (frame: Uint8Array) => void, onSync: () => void) {
		this.framers = Array.from({ length: 10 }, () => new Rs41Framer(onFrame, onSync));
	}
	reset(): void {
		this.previousI = this.previousQ = this.dc = this.sum = this.index = 0;
		this.window.fill(0);
		this.framers.forEach((framer) => framer.reset());
	}
	process(iq: Float32Array): void {
		for (let offset = 0; offset + 1 < iq.length; offset += 2) {
			const i = iq[offset];
			const q = iq[offset + 1];
			const fm = Math.atan2(q * this.previousI - i * this.previousQ, i * this.previousI + q * this.previousQ);
			this.previousI = i;
			this.previousQ = q;
			this.dc += 0.0005 * (fm - this.dc);
			this.sum += fm - this.dc - this.window[this.index];
			this.window[this.index] = fm - this.dc;
			this.framers[this.index].bit(this.sum >= 0 ? 1 : 0);
			this.index = (this.index + 1) % 10;
		}
	}
}
