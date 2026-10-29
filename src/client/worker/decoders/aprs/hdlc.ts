// Two 7-byte addresses, control and FCS; the AX.25 parser applies stricter checks.
const MIN_FRAME_BYTES = 17;
// Ten addresses, control, PID, a 256-byte information field and FCS, plus worst-case bit stuffing.
const MAX_FRAME_BITS = 4096;

/** AX.25 frame check sequence: CRC-16/X-25, transmitted least significant byte first. */
export function ax25Crc(bytes: Uint8Array): number {
	let crc = 0xffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x8408 : 0);
	}
	return crc ^ 0xffff;
}

/** HDLC flag detection, bit unstuffing and FCS validation for NRZI-decoded bits, least significant bit first. */
export class Ax25Hdlc {
	private shift = 0;
	private collecting = false;
	private length = 0;
	private raw = new Uint8Array(MAX_FRAME_BITS);
	constructor(private onFrame: (frame: Uint8Array) => void) {}
	get inFrame(): boolean {
		return this.collecting && this.length > 8;
	}
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
		// Seven consecutive ones abort the frame.
		if ((this.shift & 0x7f) === 0x7f) {
			this.collecting = false;
			return;
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
		if (count % 8 || count < MIN_FRAME_BYTES * 8) return;
		const size = count / 8;
		const payload = bytes.subarray(0, size - 2);
		if (ax25Crc(payload) === (bytes[size - 2] | (bytes[size - 1] << 8))) this.onFrame(payload.slice());
	}
}
