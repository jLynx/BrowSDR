import type { LoraHeader, LoraPacket } from './types';

const mod = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;
const reverseNibble = (value: number) => ((value & 1) << 3) | ((value & 2) << 1) | ((value & 4) >> 1) | ((value & 8) >> 3);
function parity(value: number): number {
	value ^= value >> 8;
	value ^= value >> 4;
	return (0x6996 >> (value & 15)) & 1;
}

function hammingWord(nibble: number, rate: number): number {
	const a = nibble & 1,
		b = (nibble >> 1) & 1,
		c = (nibble >> 2) & 1,
		d = (nibble >> 3) & 1;
	const checks = ((a ^ b ^ c) << 3) | ((b ^ c ^ d) << 2) | ((a ^ b ^ d) << 1) | (a ^ c ^ d);
	return ((reverseNibble(nibble) << 4) | checks) >> (4 - rate);
}

/** Gray demapping, diagonal deinterleaving and systematic Hamming decoding. */
export function decodeBlock(bins: number[], bits: number, rate: number): number[] {
	const columns = rate + 4;
	const words = new Uint8Array(bits);
	for (let column = 0; column < columns; column++) {
		const symbol = bins[column] ^ (bins[column] >> 1);
		for (let bit = 0; bit < bits; bit++) words[mod(column - bit - 1, bits)] |= ((symbol >> (bits - bit - 1)) & 1) << (columns - column - 1);
	}
	return Array.from(words, (word) => {
		if (rate <= 2) return reverseNibble(word >> rate);
		let best = 0,
			distance = 9;
		for (let nibble = 0; nibble < 16; nibble++) {
			let different = word ^ hammingWord(nibble, rate),
				count = 0;
			for (; different; different &= different - 1) count++;
			if (count < distance) {
				distance = count;
				best = nibble;
			}
		}
		return best;
	});
}

export function decodeHeader(bins: number[], ldro: boolean): LoraHeader | undefined {
	const nibbles = decodeBlock(
		bins.map((bin) => Math.floor(mod(bin - 1, 128) / 4)),
		5,
		4,
	);
	const input = (nibbles[0] << 8) | (nibbles[1] << 4) | nibbles[2];
	// LoRa's five explicit-header parity equations, in MSB-first order.
	const checksum = [0xf00, 0x8e1, 0x49a, 0x257, 0x12f].reduce((result, mask) => (result << 1) | parity(input & mask), 0);
	const length = input >> 4,
		codingRate = nibbles[2] >> 1,
		hasCrc = !!(nibbles[2] & 1);
	if (!length || codingRate < 1 || codingRate > 4 || checksum !== (((nibbles[3] & 1) << 4) | nibbles[4])) return;
	const symbols = 8 + Math.ceil((2 * length - 7 + 2 + 5 + (hasCrc ? 4 : 0)) / (ldro ? 5 : 7)) * (4 + codingRate);
	return { length, codingRate, hasCrc, symbols };
}

export function crc16(data: Uint8Array): number {
	let crc = 0;
	for (const byte of data) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
	}
	return crc;
}

export function decodePayload(bins: number[], header: LoraHeader, ldro: boolean, cfoHz: number): LoraPacket {
	const nibbles: number[] = [];
	const columns = header.codingRate + 4;
	for (let offset = 8; offset < header.symbols; offset += columns) {
		const symbols = bins.slice(offset, offset + columns).map((bin) => Math.floor(mod(bin - 1, 128) / (ldro ? 4 : 1)));
		nibbles.push(...decodeBlock(symbols, ldro ? 5 : 7, header.codingRate));
	}
	const bytes = Uint8Array.from({ length: header.length + (header.hasCrc ? 2 : 0) }, (_, i) => nibbles[2 * i] | (nibbles[2 * i + 1] << 4));
	let whitening = 255;
	for (let i = 0; i < header.length; i++) {
		bytes[i] ^= whitening;
		const feedback = ((whitening >> 7) ^ (whitening >> 5) ^ (whitening >> 4) ^ (whitening >> 3)) & 1;
		whitening = ((whitening << 1) | feedback) & 255;
	}
	const length = header.length;
	const calculated = length >= 2 ? crc16(bytes.subarray(0, length - 2)) ^ bytes[length - 1] ^ (bytes[length - 2] << 8) : -1;
	const verified = header.hasCrc && calculated === (bytes[length] | (bytes[length + 1] << 8));
	return { data: bytes.slice(0, length), verified, hasCrc: header.hasCrc, codingRate: header.codingRate, cfoHz };
}
