/** Small radix-two FFT, with reusable buffers and precomputed rotations. */
export class ChirpFft {
	readonly real = new Float64Array(128);
	readonly imag = new Float64Array(128);
	private cos = Float64Array.from({ length: 64 }, (_, i) => Math.cos((-2 * Math.PI * i) / 128));
	private sin = Float64Array.from({ length: 64 }, (_, i) => Math.sin((-2 * Math.PI * i) / 128));
	transform(): void {
		const r = this.real,
			q = this.imag;
		for (let i = 1, j = 0; i < 128; i++) {
			let bit = 64;
			for (; j & bit; bit >>= 1) j ^= bit;
			j ^= bit;
			if (i < j) {
				[r[i], r[j]] = [r[j], r[i]];
				[q[i], q[j]] = [q[j], q[i]];
			}
		}
		for (let width = 2; width <= 128; width *= 2) {
			for (let base = 0; base < 128; base += width) {
				for (let j = 0; j < width / 2; j++) {
					const k = (j * 128) / width;
					const a = base + j,
						b = a + width / 2;
					const tr = r[b] * this.cos[k] - q[b] * this.sin[k];
					const tq = r[b] * this.sin[k] + q[b] * this.cos[k];
					r[b] = r[a] - tr;
					q[b] = q[a] - tq;
					r[a] += tr;
					q[a] += tq;
				}
			}
		}
	}
}
