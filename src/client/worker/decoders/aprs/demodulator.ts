import { Ax25Hdlc } from './hdlc';

export const APRS_RATE = 48000;
const BAUD = 1200;
const BIT_SAMPLES = APRS_RATE / BAUD;
// 240 samples hold whole cycles of both Bell 202 tones (6 × 1200 Hz, 11 × 2200 Hz).
const TONE_PERIOD = 240;
// Tone correlators span 1.4 bits, like Dire Wolf's profile A low-pass filter.
const CORRELATOR_SAMPLES = 56;
// A signed 32-bit counter overflows once per bit; transitions pull it toward zero.
const PLL_STEP = Math.round(2 ** 32 / BIT_SAMPLES);
const LOCKED_INERTIA = 0.74;
const SEARCHING_INERTIA = 0.5;
// Instantaneous frequency limit of ±6.1 kHz around the carrier. Near the FM threshold, phase clicks
// otherwise put broadband impulses into the audio that the tone filters cannot reject.
const CLIP = 0.8;
// Linear-phase band-pass from 1014 to 2386 Hz over 417 taps, Dire Wolf's 1200-baud prefilter.
const PREFILTER = bandpass(417, 1014, 2386);
// Parallel slicers weight the space tone from 0.5 to 2 on a log scale to absorb pre-emphasis twist.
const SLICER_GAINS = Array.from({ length: 9 }, (_, index) => 0.5 * 4 ** (index / 8));
// Slicers finish the same frame within a few bits; stations never repeat a frame this quickly.
const DUPLICATE_SAMPLES = APRS_RATE / 2;

/** Rectangular-window FIR band-pass: the difference of two ideal low-pass filters. */
function bandpass(taps: number, low: number, high: number): Float32Array {
	const middle = (taps - 1) / 2;
	return Float32Array.from({ length: taps }, (_, index) => {
		const n = index - middle;
		const lowpass = (cutoff: number) => (n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n));
		return lowpass(high / APRS_RATE) - lowpass(low / APRS_RATE);
	});
}

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

/** Bit clock, NRZI decoding and HDLC framing for one mark/space decision threshold. */
class Slicer {
	private pll = 0;
	private level = 0;
	private previousBit = 0;
	private hdlc: Ax25Hdlc;
	constructor(
		private gain: number,
		onFrame: (frame: Uint8Array) => void,
	) {
		this.hdlc = new Ax25Hdlc(onFrame);
	}
	reset(): void {
		this.pll = this.level = this.previousBit = 0;
		this.hdlc.reset();
	}
	/** Mark and space levels are normalized to 0..1. */
	clock(mark: number, space: number): void {
		const level = mark > this.gain * space ? 1 : 0;
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

/**
 * FM discriminator and Bell 202 AFSK demodulator for 1200-baud AX.25: click limiting, a band-pass
 * prefilter, sliding quadrature correlators for the 1200 Hz mark and 2200 Hz space tones, then
 * parallel bit slicers whose identical frames are reported once.
 */
export class AprsDemodulator {
	private previousI = 0;
	private previousQ = 0;
	private carrier = 0;
	private history = new Float32Array(PREFILTER.length * 2);
	private head = 0;
	private sample = 0;
	private lane = 0;
	private sums = new Float64Array(4);
	private ring = new Float64Array(CORRELATOR_SAMPLES * 4);
	private carriers = new Float64Array(TONE_PERIOD * 4);
	private mark = new ToneLevel();
	private space = new ToneLevel();
	private slicers: Slicer[];
	private elapsed = 0;
	private recent = new Map<string, number>();
	constructor(private onFrame: (frame: Uint8Array) => void) {
		this.slicers = SLICER_GAINS.map((gain) => new Slicer(gain, (frame) => this.report(frame)));
		for (let i = 0; i < TONE_PERIOD; i++) {
			const mark = (2 * Math.PI * 1200 * i) / APRS_RATE;
			const space = (2 * Math.PI * 2200 * i) / APRS_RATE;
			this.carriers.set([Math.cos(mark), Math.sin(mark), Math.cos(space), Math.sin(space)], i * 4);
		}
	}
	reset(): void {
		this.previousI = this.previousQ = this.carrier = this.head = this.sample = this.lane = 0;
		this.history.fill(0);
		this.sums.fill(0);
		this.ring.fill(0);
		this.mark.reset();
		this.space.reset();
		for (const slicer of this.slicers) slicer.reset();
		this.recent.clear();
	}
	process(iq: Float32Array): void {
		for (let index = 0; index + 1 < iq.length; index += 2) {
			const i = iq[index];
			const q = iq[index + 1];
			const discriminator = Math.atan2(q * this.previousI - i * this.previousQ, i * this.previousI + q * this.previousQ);
			this.previousI = i;
			this.previousQ = q;
			// Track the carrier offset with bounded steps so clicks cannot drag it.
			const deviation = discriminator - this.carrier;
			this.carrier += 0.001 * Math.max(-1, Math.min(1, deviation));
			this.correlate(this.prefilter(Math.max(-CLIP, Math.min(CLIP, deviation))));
			this.elapsed++;
		}
	}
	/** Symmetric FIR over a doubled history buffer, so the newest taps are contiguous. */
	private prefilter(audio: number): number {
		const taps = PREFILTER.length;
		const middle = (taps - 1) / 2;
		this.history[this.head] = this.history[this.head + taps] = audio;
		const newest = this.head + taps;
		let sum = PREFILTER[middle] * this.history[newest - middle];
		for (let k = 0; k < middle; k++) sum += PREFILTER[k] * (this.history[newest - k] + this.history[this.head + 1 + k]);
		this.head = this.head + 1 === taps ? 0 : this.head + 1;
		return sum;
	}
	private correlate(audio: number): void {
		const lane = this.lane * 4;
		const carrier = this.sample * 4;
		for (let j = 0; j < 4; j++) {
			const value = audio * this.carriers[carrier + j];
			this.sums[j] += value - this.ring[lane + j];
			this.ring[lane + j] = value;
		}
		this.lane = this.lane + 1 === CORRELATOR_SAMPLES ? 0 : this.lane + 1;
		this.sample = this.sample + 1 === TONE_PERIOD ? 0 : this.sample + 1;
		const mark = this.mark.normalize(Math.hypot(this.sums[0], this.sums[1])) + 0.5;
		const space = this.space.normalize(Math.hypot(this.sums[2], this.sums[3])) + 0.5;
		for (const slicer of this.slicers) slicer.clock(mark, space);
	}
	private report(frame: Uint8Array): void {
		const key = String.fromCharCode(...frame);
		const seen = this.recent.get(key);
		if (seen !== undefined && this.elapsed - seen < DUPLICATE_SAMPLES) return;
		for (const [item, time] of this.recent) if (this.elapsed - time >= DUPLICATE_SAMPLES) this.recent.delete(item);
		this.recent.set(key, this.elapsed);
		this.onFrame(frame);
	}
}
