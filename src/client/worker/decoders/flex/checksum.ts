/**
 * FLEX alpha per-fragment K checksum (ARIB STD-43A 3.10.1.3). Split out of
 * frame.ts; a faithful port of the osmocom / multimon-ng K-sum.
 */

const FLEX_WORDS_PER_FRAME = 88;
const WORD_NOT_RECEIVED = 0;
const WORD_UNCORRECTABLE = 3;

// 10-bit fragment checksum field (bits 0-9 of the header word).
const ALPHA_HDR_K_MASK = 0x3ff;
// K-checksum word groups (frame.h FLEX_ALPHA_K_GRP*): bits 0-7, 8-15, 16-20.
const ALPHA_K_GRP1_MASK = 0xff;
const ALPHA_K_GRP2_SHIFT = 8;
const ALPHA_K_GRP2_MASK = 0xff;
const ALPHA_K_GRP3_SHIFT = 16;
const ALPHA_K_GRP3_MASK = 0x1f;

function wordLost(status: number): boolean {
	return status === WORD_UNCORRECTABLE || status === WORD_NOT_RECEIVED;
}

/** The body-word index list for the K checksum: Vy+MF for long, MF for short. */
export function alphaBodyWords(hdrIdx: number, mw1: number, mw2: number, isLong: boolean): number[] {
	const bodyWords: number[] = [];
	if (isLong) bodyWords.push(hdrIdx);
	for (let w = mw1; w <= mw2; w++) bodyWords.push(w);
	return bodyWords;
}

/**
 * Per-fragment 10-bit K checksum (ARIB 3.10.1.3): 1's complement of the sum of
 * three bit-groups (0-7, 8-15, 16-20) over every body word, with the header
 * word's own K field (bits 0-9) zeroed. Returns true when the recomputed K
 * matches the header's K, or null when a body word is lost (cannot verify).
 * `bodyWords` lists the body word indices in order (Vy first for long).
 */
export function verifyKChecksum(words: Uint32Array, status: Int8Array, hdrIdx: number, bodyWords: number[]): boolean | null {
	if (wordLost(status[hdrIdx])) return null;
	const hdrK = words[hdrIdx] & ALPHA_HDR_K_MASK;
	let kSum = 0;
	for (const w of bodyWords) {
		if (w >= FLEX_WORDS_PER_FRAME) continue;
		if (wordLost(status[w])) return null;
		let dw = words[w];
		if (w === hdrIdx) dw &= ~ALPHA_HDR_K_MASK; // zero the K field in the header
		kSum += dw & ALPHA_K_GRP1_MASK;
		kSum += (dw >> ALPHA_K_GRP2_SHIFT) & ALPHA_K_GRP2_MASK;
		kSum += (dw >> ALPHA_K_GRP3_SHIFT) & ALPHA_K_GRP3_MASK;
	}
	const expectedK = ~kSum & ALPHA_HDR_K_MASK;
	return hdrK === expectedK;
}
