import { Ax25Hdlc } from './hdlc';

export const APRS_RATE = 48000;
const BAUD = 1200;
const BIT_SAMPLES = APRS_RATE / BAUD;
// 240 samples hold whole cycles of both Bell 202 tones (6 × 1200 Hz, 11 × 2200 Hz) and six bit windows.
const TONE_PERIOD = 240;
// A signed 32-bit counter overflows once per bit; transitions pull it toward zero.
const PLL_STEP = Math.round(2 ** 32 / BIT_SAMPLES);
const LOCKED_INERTIA = 0.74;
const SEARCHING_INERTIA = 0.5;

/** Fast attack and slow release envelope, normalizing each tone so transmitter pre-emphasis does not bias decisions. */
class ToneLevel {
	private peak = 0;
	private valley = 0;
	reset(): void {
		this.peak = this.valley = 0;
	}
	normalize(value: number): number {
		this.peak += (value >= this.peak ? 0.7 : 0.00009) * (value - this.peak);
		this.valley += (value <= this.valley ? 0.7 : 0.00009) * (value - this.valley);
		return this.peak > this.valley ? (value - (this.peak + this.valley) / 2) / (this.peak - this.valley) : 0;
	}
}

/**
 * FM discriminator and Bell 202 AFSK demodulator for 1200-baud AX.25: sliding one-bit quadrature
 * correlators for the 1200 Hz mark and 2200 Hz space tones, then a PLL bit clock and NRZI decoding.
 */
export class AprsDemodulator {
	private previousI = 0;
	private previousQ = 0;
	private dc = 0;
	private sample = 0;
	private sums = new Float64Array(4);
	private ring = new Float64Array(BIT_SAMPLES * 4);
	private carriers = new Float64Array(TONE_PERIOD * 4);
	private mark = new ToneLevel();
	private space = new ToneLevel();
	private pll = 0;
	private level = 0;
	private previousBit = 0;
	private hdlc: Ax25Hdlc;
	constructor(onFrame: (frame: Uint8Array) => void) {
		this.hdlc = new Ax25Hdlc(onFrame);
		for (let i = 0; i < TONE_PERIOD; i++) {
			const mark = (2 * Math.PI * 1200 * i) / APRS_RATE;
			const space = (2 * Math.PI * 2200 * i) / APRS_RATE;
			this.carriers.set([Math.cos(mark), Math.sin(mark), Math.cos(space), Math.sin(space)], i * 4);
		}
	}
	reset(): void {
		this.previousI = this.previousQ = this.dc = this.sample = this.pll = this.level = this.previousBit = 0;
		this.sums.fill(0);
		this.ring.fill(0);
		this.mark.reset();
		this.space.reset();
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
			this.correlate(discriminator - this.dc);
		}
	}
	private correlate(audio: number): void {
		const lane = (this.sample % BIT_SAMPLES) * 4;
		const carrier = (this.sample % TONE_PERIOD) * 4;
		for (let j = 0; j < 4; j++) {
			const value = audio * this.carriers[carrier + j];
			this.sums[j] += value - this.ring[lane + j];
			this.ring[lane + j] = value;
		}
		this.sample = (this.sample + 1) % TONE_PERIOD;
		const mark = this.mark.normalize(Math.hypot(this.sums[0], this.sums[1]));
		const space = this.space.normalize(Math.hypot(this.sums[2], this.sums[3]));
		this.clock(mark > space ? 1 : 0);
	}
	private clock(level: number): void {
		const previous = this.pll;
		this.pll = (this.pll + PLL_STEP) | 0;
		if (previous > 0 && this.pll < 0) {
			// NRZI: an unchanged tone is a one and a tone change is a zero.
			this.hdlc.bit(level === this.previousBit ? 1 : 0);
			this.previousBit = level;
		}
		if (level !== this.level) {
			this.pll = Math.trunc(this.pll * (this.hdlc.inFrame ? LOCKED_INERTIA : SEARCHING_INERTIA));
			this.level = level;
		}
	}
}
