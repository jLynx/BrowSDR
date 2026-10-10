/** Bounded, MSB-first bit reader for ARINC application payloads. */
export class Bits {
	position = 0;
	constructor(readonly bytes: Uint8Array) {}
	get remaining() {
		return this.bytes.length * 8 - this.position;
	}
	read(count: number): number {
		if (count < 0 || count > 32 || this.remaining < count) throw new Error('Truncated application data');
		let value = 0;
		for (let i = 0; i < count; i++) {
			value = value * 2 + ((this.bytes[this.position >> 3] >> (7 - (this.position % 8))) & 1);
			this.position++;
		}
		return value;
	}
	signed(count: number): number {
		const value = this.read(count);
		return value >= 2 ** (count - 1) ? value - 2 ** count : value;
	}
	constrained(count: number, minimum: number, maximum: number): number {
		const value = this.read(count) + minimum;
		if (value > maximum) throw new Error('Invalid constrained value');
		return value;
	}
	text(length: number, token = false): string {
		let value = '';
		for (let i = 0; i < length; i++) value += String.fromCharCode(this.read(7));
		if (token && !/^[A-Z0-9 -]+$/.test(value)) throw new Error('Invalid identifier');
		return value.trimEnd();
	}
	paddingOnly(): boolean {
		if (this.remaining > 7) return false;
		const position = this.position;
		const valid = this.read(this.remaining) === 0;
		this.position = position;
		return valid;
	}
}

export function hexBytes(hex: string): Uint8Array {
	if (!/^(?:[A-Fa-f0-9]{2})+$/.test(hex) || hex.length > 16_384) throw new Error('Invalid application hex');
	return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}

/** libacars ARINC CRC: IMI + fixed seven-character aircraft address + binary body/checksum. */
export function validArincCrc(prefix: string, bytes: Uint8Array): boolean {
	let crc = 0xffff;
	for (const byte of [...prefix].map((char) => char.charCodeAt(0)).concat([...bytes])) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
	}
	return crc === 0x1d0f;
}
