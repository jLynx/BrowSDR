// Synthetic GSC encoder, using the established Golay regression layout.
const GEN_GOL = 0x00000c75;
const GEN_BCH = 0x00000117;
const START_CODE = 713;
const WORD1S = [
	721, 2731, 2952, 1387, 1578, 1708, 2650, 1747, 2580, 1376, 2692, 696, 1667, 3800, 3552, 3424, 1384, 3595, 876, 3124, 2285, 2608, 899,
	3684, 3129, 2124, 1287, 2616, 1647, 3216, 375, 1232, 2824, 1840, 408, 3127, 3387, 882, 3468, 3267, 1575, 3463, 3152, 2572, 1252, 2592,
	1552, 835, 1440, 160,
];

/** Golay(23,12) systematic encode. */
function encGolay(data) {
	let syndrome = (data & 0xfff) << 11;
	let aux = 0x00400000;
	if (syndrome >= 0x800) {
		while (syndrome & 0xfffff800) {
			while (!(aux & syndrome)) aux = aux >>> 1;
			syndrome = (syndrome ^ (Math.floor(aux / 0x800) * GEN_GOL)) >>> 0;
		}
	}
	return ((data & 0xfff) | (syndrome << 12)) >>> 0;
}

/** BCH(15,7) systematic encode. */
function encBch(data) {
	let syndrome = (data & 0x7f) << 8;
	let aux = 0x4000;
	if (syndrome >= 0x100) {
		while (syndrome & 0xff00) {
			while (!(aux & syndrome)) aux = aux >>> 1;
			syndrome = (syndrome ^ (Math.floor(aux / 0x100) * GEN_BCH)) & 0xffff;
		}
	}
	return ((data & 0x7f) | (syndrome << 7)) & 0xffff;
}

class Enc {
	constructor() {
		this.bits = [];
	}
	bit(b) {
		this.bits.push(b & 1);
	}
	comma(len, startBit) {
		for (let i = 0; i < len; i++) this.bit((startBit + i) & 1);
	}
	dup(cw, n) {
		for (let i = 0; i < n; i++) {
			this.bit((cw >> i) & 1);
			this.bit((cw >> i) & 1);
		}
	}
}

/** Encode uppercase ASCII subset into 6-bit Table VII codes. */
function alphaCodes(msg) {
	const codes = [];
	for (const ch of msg.toUpperCase()) codes.push((ch.charCodeAt(0) - 0x20) & 0x3f);
	return codes;
}

/** One alpha data block: pack 8 six-bit chars into 7 data bytes, checksum,
 * BCH-encode, interleave. Emits 1 comma bit + 120 block bits. contbit sets the
 * continuation flag (bit 6 of d[6]) so multiple blocks chain. */
function encodeAlphaBlock(enc, chars, contbit = 0) {
	const c = new Array(8).fill(0x3e); // 0x3E fill
	for (let i = 0; i < Math.min(8, chars.length); i++) c[i] = chars[i] & 0x3f;
	const d = new Array(8).fill(0);
	d[0] = (c[0] | (c[1] << 6)) & 0x7f;
	d[1] = ((c[1] >> 1) | (c[2] << 5)) & 0x7f;
	d[2] = ((c[2] >> 2) | (c[3] << 4)) & 0x7f;
	d[3] = ((c[3] >> 3) | (c[4] << 3)) & 0x7f;
	d[4] = ((c[4] >> 4) | (c[5] << 2)) & 0x7f;
	d[5] = ((c[5] >> 5) | (c[6] << 1)) & 0x7f;
	d[6] = (c[7] & 0x3f) | ((contbit & 1) << 6); // bits 0-5 char7, bit6 continuation
	let cksum = 0;
	for (let k = 0; k < 7; k++) cksum += encBch(d[k]); // sum full 15-bit codewords
	d[7] = cksum & 0x7f;
	const bch = d.map((x) => encBch(x));
	enc.bit(0); // 1-bit inverted comma
	for (let j = 0; j < 15; j++) for (let k = 0; k < 8; k++) enc.bit((bch[k] >> j) & 1);
}

/** Encode an alpha message of any length as chained 8-char blocks. */
function encodeAlphaMessage(enc, message) {
	const codes = alphaCodes(message);
	for (let off = 0; off < codes.length; off += 8) {
		const slice = codes.slice(off, off + 8);
		const more = off + 8 < codes.length ? 1 : 0;
		encodeAlphaBlock(enc, slice, more);
	}
}

export function encodeBatch(word1Idx, w2, func, message, withPreamble = false) {
	const enc = new Enc();
	if (withPreamble) {
		// Preamble: 28-bit comma + 18 dup codewords of preamble_values[0],
		// matching the encoder; decode reports preamble index 0.
		const pg = encGolay(2030); // preamble_values[0]
		enc.comma(28, pg & 1);
		for (let i = 0; i < 18; i++) enc.dup(pg, 23);
	}
	// Start code.
	let g = encGolay(START_CODE);
	enc.comma(28, g & 1);
	enc.dup(g, 23);
	const gc = (g ^ 0x7fffff) >>> 0;
	enc.bit((gc & 1) ^ 1);
	enc.dup(gc, 23);
	// Address W1.
	g = encGolay(WORD1S[word1Idx]);
	if (func & 0x2) g = (g ^ 0x7fffff) >>> 0;
	enc.comma(28, g & 1);
	enc.dup(g, 23);
	// Address W2.
	g = encGolay(w2);
	if (func & 0x1) g = (g ^ 0x7fffff) >>> 0;
	enc.bit((g & 1) ^ 1);
	enc.dup(g, 23);
	// Alpha data block(s) — chained for messages longer than 8 chars.
	encodeAlphaMessage(enc, message);
	// Tail so decodeContent has room past the final block.
	for (let i = 0; i < 200; i++) enc.bit(i & 1);
	return enc.bits;
}
