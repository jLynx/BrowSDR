// DU1021D reversible wire transform, validated against recorded RTK2 CRC8/CRC16 frames.
const SUBSTITUTE = [3, 7, 11, 13, 15, 14, 12, 9, 5, 1, 0, 2, 4, 6, 8, 10];
const MASK = [0xab, 0x37, 0x69, 0x38, 0xbc, 0xa3, 0x3f, 0xfd];
const BIT_ORDER = [2, 6, 0, 7, 5, 4, 1, 3];
const swap = (byte: number) => ((byte << 4) | (byte >> 4)) & 255;

function block(input: Uint8Array, output: Uint8Array): void {
	const nibbles = new Uint8Array(16);
	let parity = 0;
	for (let row = 0; row < 8; row++) {
		let byte = 0;
		for (let column = 0; column < 8; column++) byte |= ((input[column] >> (7 - row)) & 1) << (7 - column);
		nibbles[2 * row] = SUBSTITUTE[byte >> 4];
		nibbles[2 * row + 1] = SUBSTITUTE[byte & 15];
		parity ^= nibbles[2 * row] ^ nibbles[2 * row + 1];
	}
	for (let i = 0; i < 8; i++) output[i] = swap((((nibbles[2 * i] ^ parity) << 4) | (nibbles[2 * i + 1] ^ parity)) ^ MASK[i]);
}

/** The final short block uses a separate byte permutation. LoRa whitening is already removed. */
export function decodeRtk2Bytes(input: Uint8Array): Uint8Array {
	const output = new Uint8Array(input.length);
	let offset = 0;
	for (; offset + 8 <= input.length; offset += 8) block(input.subarray(offset, offset + 8), output.subarray(offset));
	for (; offset < input.length; offset++) {
		const byte = (SUBSTITUTE[input[offset] >> 4] << 4) | SUBSTITUTE[input[offset] & 15];
		let permuted = 0;
		for (let bit = 0; bit < 8; bit++) permuted |= ((byte >> bit) & 1) << BIT_ORDER[bit];
		output[offset] = swap(permuted ^ 0xa3);
	}
	return output;
}
