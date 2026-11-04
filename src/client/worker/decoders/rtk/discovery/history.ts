/** Short, precision-preserving full-band IQ history for delayed spectrum hints. */
export class RtkIqHistory {
	private data = new Uint8Array(0);
	private write = 0;
	private length = 0;
	private rate = 0;
	private bytesPerValue = 1;
	private total = 0;
	private revision = 0;
	constructor(
		private memory: { buffer: ArrayBuffer },
		private seconds = 0.5,
		private maximumBytes = 64 * 1024 * 1024,
	) {}
	get duration(): number {
		return this.rate ? this.length / (2 * this.bytesPerValue * this.rate) : 0;
	}
	get byteLength(): number {
		return this.data.length;
	}
	get end(): number {
		return this.total;
	}
	get generation(): number {
		return this.revision;
	}
	get start(): number {
		return this.total - this.length / this.bytesPerValue;
	}
	append(ptr: number, values: number, floatInput: boolean, rate: number): void {
		const bytesPerValue = floatInput ? 4 : 1;
		if (rate !== this.rate || bytesPerValue !== this.bytesPerValue) {
			this.rate = rate;
			this.bytesPerValue = bytesPerValue;
			const pairBytes = 2 * bytesPerValue;
			const capacity = Math.floor(Math.min(rate * this.seconds * pairBytes, this.maximumBytes) / pairBytes) * pairBytes;
			this.data = new Uint8Array(capacity);
			this.clear();
		}
		if (!this.data.length || !values) return;
		const bytes = Math.min(values * bytesPerValue, this.data.length);
		const input = new Uint8Array(this.memory.buffer, ptr + values * bytesPerValue - bytes, bytes);
		const first = Math.min(bytes, this.data.length - this.write);
		this.data.set(input.subarray(0, first), this.write);
		this.data.set(input.subarray(first), 0);
		this.write = (this.write + bytes) % this.data.length;
		this.length = Math.min(this.length + bytes, this.data.length);
		this.total += values;
	}
	/** Borrow the input allocation for history, then restore the live chunk, even on failure/growth. */
	replay(
		ptr: number,
		capacityValues: number,
		floatInput: boolean,
		consume: (ptr: number, values: number, floatInput: boolean) => void,
	): void {
		this.read(this.start, this.end - this.start, ptr, capacityValues, floatInput, consume);
	}
	/** Decode bounded history by absolute IQ index, allowing catch-up over several deliveries. */
	read(
		start: number,
		values: number,
		ptr: number,
		capacityValues: number,
		floatInput: boolean,
		consume: (ptr: number, values: number, floatInput: boolean) => void,
	): void {
		const bytesPerValue = floatInput ? 4 : 1;
		if (!values || start < this.start || start + values > this.end || bytesPerValue !== this.bytesPerValue || capacityValues < 2) return;
		const capacity = (capacityValues - (capacityValues % 2)) * bytesPerValue;
		const live = new Uint8Array(this.memory.buffer, ptr, capacityValues * bytesPerValue).slice();
		let read = (this.write + this.data.length - (this.end - start) * bytesPerValue) % this.data.length;
		try {
			for (let remaining = values * bytesPerValue; remaining > 0;) {
				const bytes = Math.min(remaining, capacity, this.data.length - read);
				new Uint8Array(this.memory.buffer, ptr, bytes).set(this.data.subarray(read, read + bytes));
				consume(ptr, bytes / bytesPerValue, floatInput);
				remaining -= bytes;
				read = (read + bytes) % this.data.length;
			}
		} finally {
			new Uint8Array(this.memory.buffer, ptr, live.length).set(live);
		}
	}
	clear(): void {
		this.revision++;
		this.write = this.length = this.total = 0;
	}
	reset(): void {
		this.clear();
		this.data = new Uint8Array(0);
		this.rate = 0;
	}
}
