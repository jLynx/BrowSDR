/**
 * FLEX forward-error-correction: BCH(31,21,2) + even parity over GF(2^5),
 * and the combined A / inv.A sync cross-correction. A faithful port of the
 * osmocom-analog src/flex/dsp.c flex_bch_* routines.
 *
 * BCH(31,21) + even parity = 32-bit codeword. The field is GF(2^5) with
 * primitive polynomial x^5 + x^2 + 1 (0x25). Up to t=2 bit errors are
 * corrected by syndrome lookup; the parity bit extends the minimum distance
 * from 5 to 6 (2-bit correct + 3-bit detect), halving the false-accept rate on
 * a sliding bitstream -- exactly as in POCSAG.
 *
 * RX codeword layout (after LSB-first accumulation):
 *   bits 0-20  = 21 data (info) bits
 *   bits 21-30 = 10 BCH parity bits
 *   bit 31     = even parity bit
 */

import type { BchResult } from './bch.types';

const BCH_GF_PRIM_POLY = 0x25;
const BCH_CODE_LEN = 31; // 2^5 - 1

/** BCH decode status: 0 = clean, 1 = corrected, -1 = uncorrectable. */
export const BCH_CLEAN = 0;
export const BCH_CORRECTED = 1;
export const BCH_UNCORRECTABLE = -1;

// -- GF(2^5) field + syndrome tables, built once ----------------------------
const expTbl = new Uint8Array(32); // alpha^i -> polynomial representation
const logTbl = new Uint8Array(32); // polynomial -> exponent
const s1Tbl = new Uint8Array(BCH_CODE_LEN); // S1[i] = alpha^i
const s3Tbl = new Uint8Array(BCH_CODE_LEN); // S3[i] = alpha^(3i)
const bitKey = new Uint32Array(BCH_CODE_LEN); // syndrome key per 1-bit error
const errTbl = new Uint32Array(1024); // (S1<<5)|S3 -> error bit pattern
let tablesReady = false;

function initTables(): void {
	if (tablesReady) return;

	// Build GF(2^5) exp/log tables from the primitive polynomial.
	let elem = 1;
	for (let i = 0; i < BCH_CODE_LEN; i++) {
		expTbl[i] = elem;
		logTbl[elem] = i;
		elem <<= 1;
		if (elem & 0x20) elem ^= BCH_GF_PRIM_POLY;
	}
	logTbl[0] = 0;

	// Syndrome tables.
	for (let i = 0; i < BCH_CODE_LEN; i++) {
		s1Tbl[i] = expTbl[i];
		s3Tbl[i] = expTbl[(3 * i) % BCH_CODE_LEN];
	}

	// Error-correction lookup. Bit position in the uint32: bit 0 = recv[30],
	// bit 30 = recv[0]. Single-bit errors first, then 2-bit patterns.
	errTbl.fill(0);
	for (let i = 0; i < BCH_CODE_LEN; i++) {
		const recvIdx = 30 - i;
		const key = (s1Tbl[recvIdx] << 5) | s3Tbl[recvIdx];
		bitKey[i] = key;
		errTbl[key] = (1 << i) >>> 0;
	}
	for (let i = 0; i < BCH_CODE_LEN; i++) {
		for (let j = i + 1; j < BCH_CODE_LEN; j++) {
			const key = bitKey[i] ^ bitKey[j];
			if (errTbl[key] === 0) errTbl[key] = ((1 << i) | (1 << j)) >>> 0;
		}
	}

	tablesReady = true;
}

/** Hamming weight of a 32-bit value. */
export function countBits(data: number): number {
	let d = data >>> 0;
	let n = (d >>> 1) & 0x77777777;
	d = (d - n) >>> 0;
	n = (n >>> 1) & 0x77777777;
	d = (d - n) >>> 0;
	n = (n >>> 1) & 0x77777777;
	d = (d - n) >>> 0;
	d = (d + (d >>> 4)) & 0x0f0f0f0f;
	d = (d * 0x01010101) >>> 0;
	return d >>> 24;
}

/** Syndrome key (S1<<5)|S3 for a 31-bit codeword; iterates over set bits. */
function syndrome(codeword: number): number {
	let s1 = 0;
	let s3 = 0;
	let cw = codeword >>> 0;
	while (cw) {
		const bit = 31 - Math.clz32(cw & -cw); // index of lowest set bit
		const recvIdx = 30 - bit;
		s1 ^= s1Tbl[recvIdx];
		s3 ^= s3Tbl[recvIdx];
		cw &= (cw - 1) >>> 0; // clear lowest set bit
	}
	return ((s1 << 5) | s3) >>> 0;
}

/**
 * BCH(31,21)+parity decode. Mirrors osmocom flex_bch_decode decision matrix:
 *   syndrome=0, parity OK  -> clean
 *   syndrome=0, parity BAD -> single error in the parity bit -> corrected
 *   syndrome!=0, correction found, parity OK after -> corrected
 *   syndrome!=0, correction found, parity BAD after -> 3+ errors -> reject
 *   syndrome!=0, no correction -> uncorrectable
 */
export function bchDecode(codeword: number): BchResult {
	initTables();

	const cw = codeword >>> 0;
	const code31 = cw & 0x7fffffff;
	const key = syndrome(code31);
	const parityBad = countBits(cw) & 1; // odd popcount = parity error

	if (key === 0) {
		if (!parityBad) {
			return { info: code31 & 0x1fffff, status: BCH_CLEAN, corrected: cw };
		}
		// Syndrome clean but overall parity odd -> the lone error is the parity
		// bit; the 21 data bits are already correct. Rebuild with even parity.
		return { info: code31 & 0x1fffff, status: BCH_CORRECTED, corrected: recomputeParity(code31) };
	}

	const error = errTbl[key];
	if (error === 0) {
		return { info: -1, status: BCH_UNCORRECTABLE, corrected: 0 };
	}

	const fixed31 = (code31 ^ error) >>> 0;
	// Reassemble the full 32-bit word with the RECEIVED parity bit (bit 31 of
	// the original codeword) and the CORRECTED code31. If parity is now odd,
	// there were 3+ total errors and BCH miscorrected -> reject. This is the
	// check the parity bit exists for (raises min distance 5 -> 6); testing a
	// freshly recomputed parity instead would make the branch dead.
	if (countBits(((cw & 0x80000000) >>> 0) | fixed31) & 1) {
		return { info: -1, status: BCH_UNCORRECTABLE, corrected: 0 };
	}
	// Correction valid: return code31 with a correct even-parity bit.
	return { info: fixed31 & 0x1fffff, status: BCH_CORRECTED, corrected: recomputeParity(fixed31) };
}

/** Rebuild the 32-bit word from a 31-bit code with an even-parity bit 31. */
function recomputeParity(code31: number): number {
	const c = code31 & 0x7fffffff;
	const parity = countBits(c) & 1 ? 0x80000000 : 0;
	return (c | parity) >>> 0;
}

// BCH(31,21) generator polynomial (frame.h FLEX_BCH_POLY).
const BCH_POLY = 0x769;

/**
 * Encode 21 info bits into a 32-bit FLEX codeword in the RX layout this
 * decoder uses (bits 0-20 info, 21-30 ECC, 31 even parity), such that
 * bchDecode returns the original info CLEAN. The ECC is the unique 10-bit
 * value that zeroes the decoder's syndrome; parity is then set even. Used to
 * build synthetic frames in tests. Faithful to the same BCH(31,21,2)+parity
 * code as osmocom flex_encode_word, expressed in this decoder's bit order.
 */
export function bchEncode(info: number): number {
	initTables();
	const data = info & 0x1fffff;
	for (let ecc = 0; ecc < 1024; ecc++) {
		const code31 = (data | (ecc << 21)) >>> 0;
		if (syndrome(code31) === 0) {
			const parity = countBits(code31) & 1 ? 0x80000000 : 0;
			return (code31 | parity) >>> 0;
		}
	}
	// Unreachable for a valid systematic code (BCH_POLY ensures a solution).
	return (data | (BCH_POLY << 21)) >>> 0;
}

/**
 * Combined A / inv.A error correction for S1 sync validation.
 *
 * A and ~inv.A are both BCH(31,21)+parity codewords encoding the same 21-bit
 * info. Decoding both and cross-validating recovers more errors than BCH alone.
 * Returns the corrected 32-bit A codeword, or 0 on failure. The 16-bit sync
 * code is then (~result >>> 16) & 0xFFFF.
 *
 * Mirrors osmocom flex_combined_a_correction.
 */
export function combinedACorrection(aRaw: number, invARaw: number): number {
	const bRaw = ~invARaw >>> 0; // ~inv.A should equal A
	const ra = bchDecode(aRaw);
	const rb = bchDecode(bRaw);

	// Case 1: both decoded.
	if (ra.info >= 0 && rb.info >= 0) {
		if (ra.corrected === rb.corrected) return ra.corrected;
		return 0; // both OK but disagree -> not a real sync
	}

	// Case 2: exactly one decoded -> use it to repair the other by trying each
	// single-bit flip of the failed raw word (<=3 candidate diffs).
	const good = ra.info >= 0 ? ra : rb;
	const failedRaw = ra.info >= 0 ? bRaw : aRaw;
	if (good.info < 0) return 0; // both failed

	const diff = (failedRaw ^ good.corrected) >>> 0;

	// Try flipping each differing bit of the failed raw word and re-attempt BCH;
	// if one flip makes it decode to the good side, the sync is recovered.
	// Mirrors C's `ndiff <= 31` (i.e. always try) iterating every set bit of
	// diff -- not the stale "<=3 diffs" comment the C body no longer follows.
	for (let bit = 0; bit < 32; bit++) {
		if (!((diff >>> bit) & 1)) continue;
		const trial = (failedRaw ^ ((1 << bit) >>> 0)) >>> 0;
		const r = bchDecode(trial);
		if (r.info >= 0 && r.corrected === good.corrected) return good.corrected;
	}
	return 0;
}
