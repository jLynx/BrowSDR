/**
 * FLEX numeric vector decode: BCD digit extraction (standard / special /
 * numbered numeric) and the numbered-numeric header (N / R / S). A faithful
 * port of the osmocom dsp.c numeric path.
 */

import type { FlexMessage } from './types';

const FLEX_WORDS_PER_FRAME = 88;
const FLEX_BCH_DATA_BITS = 21;
const WORD_NOT_RECEIVED = 0;
const WORD_UNCORRECTABLE = 3;

// Vector type for numbered numeric (frame.h FLEX_VECTOR_TYPE_NUMBERED_NUM).
const VEC_NUMBERED_NUM = 0x7;
// Numeric overhead: 2 bits (standard/special), 10 for numbered (K5K4+N+R+S).
const NUM_OVERHEAD_BITS = 2;
const NUM_NUMBERED_SKIP_BITS = 10;
// Numbered-numeric header fields in body[0]: K5K4(0-1), N(2-7), R(8), S(9).
const NUM_N_SHIFT = 2;
const NUM_N_MASK = 0x3f;
const NUM_R_SHIFT = 8;
const NUM_S_SHIFT = 9;
// BCD table (Table 3.10.2.1-1): 0-9 digits, A=spare('.'), B=U, C=space,
// D=hyphen, E=], F=[.
export const BCD_TABLE = '0123456789.U -][';

function wordLost(status: number): boolean {
	return status === WORD_UNCORRECTABLE || status === WORD_NOT_RECEIVED;
}

/**
 * Extract 4-bit BCD numeric digits (LSB-first nibbles) from an ordered list of
 * message word indices, processed as ONE continuous stream: the skip (2
 * overhead bits, 10 for numbered) is consumed once at the very start, and a
 * nibble straddling a word boundary carries across. Mirrors osmocom dsp.c
 * numeric decode, where body[0] (Vy for long addresses) and the message-field
 * words form a single running bit stream.
 */
export function extractNumeric(words: Uint32Array, status: Int8Array, wordIdx: number[], vecType: number): string {
	const skipBits = vecType === VEC_NUMBERED_NUM ? NUM_NUMBERED_SKIP_BITS : NUM_OVERHEAD_BITS;
	let out = '';
	let bitCount = 0;
	let nibble = 0;
	for (const w of wordIdx) {
		if (w >= FLEX_WORDS_PER_FRAME) break;
		if (wordLost(status[w])) {
			const lostDigits = (FLEX_BCH_DATA_BITS - (bitCount < skipBits ? skipBits : 0)) >> 2;
			out += '?'.repeat(lostDigits);
			bitCount += FLEX_BCH_DATA_BITS;
			continue;
		}
		const dw = words[w];
		for (let b = 0; b < FLEX_BCH_DATA_BITS; b++) {
			if (bitCount < skipBits) {
				bitCount++;
				continue;
			}
			const nibblePos = (bitCount - skipBits) % 4;
			if (nibblePos === 0) nibble = 0;
			nibble |= ((dw >> b) & 1) << nibblePos;
			if (nibblePos === 3) out += BCD_TABLE[nibble & 0x0f];
			bitCount++;
		}
	}
	return out;
}

/**
 * Build a numbered-numeric (V=111) message from its header in body[0]: K5K4
 * (bits 0-1), N message number (2-7), R new/retransmit (8), S special (9).
 * The NNUM/NSNUM kind follows S. Falls back to a plain NNUM when the header
 * word was lost.
 */
export function numberedNumericMessage(
	words: Uint32Array,
	status: Int8Array,
	hdrIdx: number,
	base: Omit<FlexMessage, 'kind' | 'text'>,
	text: string,
): FlexMessage {
	if (hdrIdx >= FLEX_WORDS_PER_FRAME || wordLost(status[hdrIdx])) {
		return { ...base, kind: 'NNUM', text };
	}
	const nhdr = words[hdrIdx];
	const special = ((nhdr >> NUM_S_SHIFT) & 1) === 1;
	return {
		...base,
		kind: special ? 'NSNUM' : 'NNUM',
		text,
		msgNumber: (nhdr >> NUM_N_SHIFT) & NUM_N_MASK,
		isNew: ((nhdr >> NUM_R_SHIFT) & 1) === 1,
		special,
	};
}

// Numeric K-checksum field positions (ARIB 3.10.1.1.1): K3-K0 in the vector
// word bits 17-20, K5K4 in body word 0 bits 0-1.
const NUM_K30_SHIFT = 17;
const NUM_K30_MASK = 0x0f;
const NUM_K54_MASK = 0x03;

/**
 * Verify the numeric 6-bit K checksum (ARIB 3.10.1.1.1). K3-K0 ride in the
 * vector word (bits 17-20) and K5K4 in body word 0 (bits 0-1). The recomputed
 * value sums three bit-groups (0-7, 8-15, 16-20) over every body word with the
 * K5K4 bits zeroed in body word 0, folds the low 8 bits as (low6 + high2), and
 * takes the 1's complement of the low 6 bits. `viw` is the vector word, `body`
 * the ordered body word indices (body0 first). Returns true/false, or null when
 * a body word was lost (cannot verify).
 */
export function verifyNumericKChecksum(words: Uint32Array, status: Int8Array, viw: number, body: number[]): boolean | null {
	if (body.length === 0) return null;
	const body0 = body[0];
	if (body0 >= FLEX_WORDS_PER_FRAME || wordLost(status[body0])) return null;
	let kSum = 0;
	for (let i = 0; i < body.length; i++) {
		const w = body[i];
		if (w >= FLEX_WORDS_PER_FRAME || wordLost(status[w])) return null;
		let dw = words[w];
		if (i === 0) dw &= ~NUM_K54_MASK; // zero K5K4 in body word 0
		kSum += dw & 0xff;
		kSum += (dw >> 8) & 0xff;
		kSum += (dw >> 16) & 0x1f;
	}
	kSum &= 0xff;
	const expected = ~((kSum & 0x3f) + (kSum >> 6)) & 0x3f;
	const rxK = (((words[body0] & NUM_K54_MASK) << 4) | ((viw >> NUM_K30_SHIFT) & NUM_K30_MASK)) & 0x3f;
	return rxK === expected;
}
