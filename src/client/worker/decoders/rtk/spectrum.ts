import { ChirpFft } from './fft';
import type { ChannelSamples } from './samples';

export class ChirpSpectrum {
	private fft = new ChirpFft();
	private cos = Float64Array.from({ length: 128 }, (_, n) => Math.cos(2 * Math.PI * ((n * n) / 256 - n / 2)));
	private sin = Float64Array.from({ length: 128 }, (_, n) => Math.sin(2 * Math.PI * ((n * n) / 256 - n / 2)));
	constructor(
		private samples: ChannelSamples,
		private oversample: number,
	) {}
	private fill(at: number, down: boolean, cfo: number): number {
		const rotation = (-2 * Math.PI * cfo) / 128;
		const stepR = Math.cos(rotation),
			stepQ = Math.sin(rotation);
		let r = 1,
			q = 0,
			energy = 0;
		for (let n = 0; n < 128; n++) {
			const i = this.samples.read(at + n * this.oversample, 0);
			const j = this.samples.read(at + n * this.oversample, 1);
			const sign = down ? 1 : -1;
			const cr = this.cos[n] * r - sign * this.sin[n] * q;
			const cq = this.cos[n] * q + sign * this.sin[n] * r;
			this.fft.real[n] = i * cr - j * cq;
			this.fft.imag[n] = i * cq + j * cr;
			energy += i * i + j * j;
			const next = r * stepR - q * stepQ;
			q = r * stepQ + q * stepR;
			r = next;
		}
		return energy;
	}
	peak(at: number, down = false, cfo = 0) {
		const energy = this.fill(at, down, cfo);
		this.fft.transform();
		let bin = 0,
			power = 0;
		for (let k = 0; k < 128; k++) {
			const value = this.fft.real[k] ** 2 + this.fft.imag[k] ** 2;
			if (value > power) {
				bin = k;
				power = value;
			}
		}
		return { bin, coherence: power / Math.max(128 * energy, 1e-30), real: this.fft.real[bin], imag: this.fft.imag[bin] };
	}
	coherence(at: number, down: boolean, cfo: number): number {
		const energy = this.fill(at, down, cfo);
		let r = 0,
			q = 0;
		for (let n = 0; n < 128; n++) {
			r += this.fft.real[n];
			q += this.fft.imag[n];
		}
		return (r * r + q * q) / Math.max(128 * energy, 1e-30);
	}
}
