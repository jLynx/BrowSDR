/** AIS uses NRZI, HDLC bit stuffing and CRC-16/X-25; bytes arrive least significant bit first. */
export function aisCrc(bytes: Uint8Array): number {
	let crc = 0xffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x8408 : 0);
	}
	return crc ^ 0xffff;
}

export class AisHdlc {
	private shift = 0;
	private collecting = false;
	private length = 0;
	private raw = new Uint8Array(2048);
	constructor(private onFrame: (frame: Uint8Array) => void) {}
	reset(): void {
		this.shift = 0;
		this.collecting = false;
		this.length = 0;
	}
	bit(value: number): void {
		this.shift = ((this.shift << 1) | value) & 255;
		if (this.collecting) {
			if (this.length === this.raw.length) this.reset();
			else this.raw[this.length++] = value;
		}
		if (this.shift !== 0x7e) return;
		if (this.collecting && this.length > 8) this.finish(this.length - 8);
		this.collecting = true;
		this.length = 0;
	}
	private finish(length: number): void {
		const bytes = new Uint8Array(Math.ceil(length / 8));
		let count = 0;
		let ones = 0;
		for (let i = 0; i < length; i++) {
			const bit = this.raw[i];
			if (ones === 5) {
				if (bit) return;
				ones = 0;
				continue;
			}
			ones = bit ? ones + 1 : 0;
			bytes[count >> 3] |= bit << (count & 7);
			count++;
		}
		if (ones === 5 || count % 8 || count < 56) return;
		const size = count / 8;
		const payload = bytes.subarray(0, size - 2);
		if (aisCrc(payload) === (bytes[size - 2] | (bytes[size - 1] << 8))) this.onFrame(payload.slice());
	}
}
