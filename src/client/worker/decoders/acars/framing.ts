// ACARS BCS: reflected CRC-16/KERMIT, initial value zero, no final XOR.
// Covers the parity-bearing mode byte through ETX/ETB, excluding SYN and SOH.
export function acarsCrc(bytes: Uint8Array): number {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x8408 : 0);
	}
	return crc;
}

export function oddParity(byte: number): boolean {
	byte ^= byte >>> 4;
	byte ^= byte >>> 2;
	byte ^= byte >>> 1;
	return (byte & 1) === 1;
}

export class AcarsFramer {
	private shift = 0;
	private bits = 0;
	private state = 0;
	private invert = 0;
	private payload: number[] = [];
	private crcBytes = 0;
	constructor(private onFrame: (frame: Uint8Array) => void) {}
	reset(): void {
		this.shift = this.bits = this.state = this.invert = this.crcBytes = 0;
		this.payload = [];
	}
	bit(value: number): void {
		this.shift = (this.shift >>> 1) | (value << 7);
		if (!this.state) {
			if (this.shift === 0x16 || this.shift === 0xe9) {
				this.invert = this.shift === 0xe9 ? 0xff : 0;
				this.state = 1;
				this.bits = 0;
			}
			return;
		}
		if (++this.bits < 8) return;
		this.bits = 0;
		const byte = this.shift ^ this.invert;
		if (this.state === 1 || this.state === 2) {
			if (byte === (this.state === 1 ? 0x16 : 0x01)) this.state++;
			else this.reset();
			return;
		}
		if (this.state === 3) {
			if (!oddParity(byte) || this.payload.length >= 240) {
				this.reset();
				return;
			}
			this.payload.push(byte);
			if (byte === 0x83 || byte === 0x97) this.state = 4;
			return;
		}
		this.payload.push(byte);
		if (++this.crcBytes === 2) {
			const bytes = Uint8Array.from(this.payload);
			if (acarsCrc(bytes) === 0) this.onFrame(bytes.slice(0, -2));
			this.reset();
		}
	}
}
