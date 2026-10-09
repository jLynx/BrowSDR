import { validAdsbFrame } from './messages';

const FRAME_SAMPLES = 241;

/** 1090ES pulse-position demodulation at 2 MS/s, preserving incomplete bursts. */
export class AdsbDemodulator {
	private magnitudes = new Float32Array(65536);
	private pending = 0;
	private frame = new Uint8Array(14);
	constructor(private onFrame: (bytes: Uint8Array) => void) {}

	process(iq: Float32Array): void {
		if (iq.length % 2) throw new Error('ADS-B requires interleaved I/Q pairs.');
		for (let offset = 0; offset < iq.length; offset += 65536) {
			const count = Math.min(65536, iq.length - offset) / 2;
			for (let i = 0; i < count; i++) {
				const real = iq[offset + i * 2];
				const imag = iq[offset + i * 2 + 1];
				this.magnitudes[this.pending + i] = real * real + imag * imag;
			}
			this.scan(this.pending + count);
		}
	}

	reset(): void {
		this.pending = 0;
	}

	private scan(length: number): void {
		let offset = 0;
		for (; offset + FRAME_SAMPLES <= length; offset++) {
			if (!this.preamble(offset)) continue;
			if (this.decode(offset)) {
				this.onFrame(this.frame);
				offset += FRAME_SAMPLES - 1;
			}
		}
		this.pending = length - offset;
		this.magnitudes.copyWithin(0, offset, length);
	}

	private decode(offset: number): boolean {
		// Sampling phase and channel filtering can move pulse energy between bins.
		// Try neighboring fractional phases; every result still requires a valid CRC.
		for (const phase of [0, -0.35, 0.35]) {
			this.frame.fill(0);
			for (let bit = 0; bit < 112; bit++) {
				const index = offset + 16 + bit * 2;
				const neighbor = phase < 0 ? -1 : 1;
				const weight = Math.abs(phase);
				const first = this.magnitudes[index] * (1 - weight) + this.magnitudes[index + neighbor] * weight;
				const second = this.magnitudes[index + 1] * (1 - weight) + this.magnitudes[index + 1 + neighbor] * weight;
				if (first > second) this.frame[bit >> 3] |= 1 << (7 - (bit & 7));
			}
			if (validAdsbFrame(this.frame)) return true;
		}
		return false;
	}

	private preamble(offset: number): boolean {
		const data = this.magnitudes;
		const high = Math.min(data[offset], data[offset + 2], data[offset + 7], data[offset + 9]);
		const low = Math.max(
			data[offset + 1],
			data[offset + 3],
			data[offset + 4],
			data[offset + 5],
			data[offset + 6],
			data[offset + 8],
			data[offset + 10],
			data[offset + 11],
			data[offset + 12],
			data[offset + 13],
			data[offset + 14],
			data[offset + 15],
		);
		return high > 1e-8 && high > low * 2;
	}
}
