import { RS41_SYNC, RS41_MASK } from './rs41';

function bitCount(value: number): number {
	value -= (value >>> 1) & 0x55555555;
	value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
	return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Streaming sync search, either polarity, including frames spanning IQ buffers. */
export class Rs41Framer {
	private high = 0;
	private low = 0;
	private bits = 0;
	private frame?: Uint8Array;
	private offset = 8;
	private byte = 0;
	private bitIndex = 0;
	private inverted = false;
	constructor(
		private onFrame: (frame: Uint8Array) => void,
		private onSync: () => void = () => {},
	) {}
	reset(): void {
		this.high = this.low = this.bits = this.bitIndex = this.byte = 0;
		this.frame = undefined;
		this.offset = 8;
	}
	bit(bit: number): void {
		if (this.frame) {
			this.byte |= (bit ^ Number(this.inverted)) << this.bitIndex++;
			if (this.bitIndex !== 8) return;
			this.frame[this.offset] = this.byte ^ RS41_MASK[this.offset % 64];
			this.offset++;
			this.byte = this.bitIndex = 0;
			if (this.offset === 320 && this.frame[56] !== 0xf0) {
				this.onFrame(this.frame.slice(0, 320));
				this.reset();
			} else if (this.offset === 518) {
				this.onFrame(this.frame);
				this.reset();
			}
			return;
		}
		this.high = ((this.high << 1) | (this.low >>> 31)) >>> 0;
		this.low = ((this.low << 1) | bit) >>> 0;
		if (++this.bits < 64) return;
		// Bits of 10 B6 CA 11 22 96 12 F8, in LSB-first wire order.
		const distance = bitCount(this.high ^ 0x086d5388) + bitCount(this.low ^ 0x4469481f);
		if (distance > 2 && distance < 62) return;
		this.inverted = distance >= 62;
		this.frame = new Uint8Array(518);
		for (let i = 0; i < 8; i++) this.frame[i] = RS41_SYNC[i] ^ RS41_MASK[i];
		this.offset = 8;
		this.onSync();
	}
}
