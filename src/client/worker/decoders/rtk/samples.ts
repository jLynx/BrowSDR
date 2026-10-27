/** Bounded channel history addressed by absolute complex sample index. */
export class ChannelSamples {
	private data = new Float32Array(1048576);
	private length = 0;
	base = 0;
	get end(): number {
		return this.base + this.length / 2;
	}
	append(input: Float32Array): void {
		if (this.length + input.length > this.data.length) throw new Error('RTK channel history overflow');
		this.data.set(input, this.length);
		this.length += input.length;
	}
	discardBefore(index: number): void {
		const count = Math.min(this.length, Math.max(0, Math.floor(index - this.base) * 2));
		if (!count) return;
		this.data.copyWithin(0, count, this.length);
		this.base += count / 2;
		this.length -= count;
	}
	read(index: number, component: number): number {
		const sample = Math.floor(index),
			fraction = index - sample;
		const offset = (sample - this.base) * 2 + component;
		return this.data[offset] * (1 - fraction) + this.data[offset + 2] * fraction;
	}
	reset(): void {
		this.length = 0;
		this.base = 0;
	}
}
