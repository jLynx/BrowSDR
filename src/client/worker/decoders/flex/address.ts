/**
 * FLEX address classification and capcode decode (frame.h Table 3.8.1-1).
 *
 * A 21-bit address word is classified by range into short / long (LA1-LA4) /
 * special (reserved, info-service/maildrop, network, temporary group, operator
 * message), and short/long capcodes are decoded by the inverse of the TX encode
 * formulas. A faithful port of osmocom flex_classify_addr_word + address decode.
 */

import type { CapClass } from './frame.types';

const SHORT_ADDR_OFFSET = 32768;
// Ordinary short-address word range (frame.h FLEX_ADDR_SHORT_MIN/MAX).
const SHORT_ADDR_MIN = 0x008001; // 32769
const SHORT_ADDR_MAX = 0x1e0000; // 1966080
// Long-address component ranges (frame.h FLEX_LA1..LA4).
const LA1_MIN = 0x000001;
const LA1_MAX = 0x008000;
const LA2_MIN = 0x1f7fff;
const LA2_MAX = 0x1ffffe;
const LA3_MIN = 0x1e0001;
const LA3_MAX = 0x1e8000;
const LA4_MIN = 0x1e8001;
const LA4_MAX = 0x1f0000;
// Special short-address ranges in the gap between LA4 and LA2 (frame.h).
const RSVD1_MIN = 0x1f0001;
const RSVD1_MAX = 0x1f27ff;
const INFO_SVC_MIN = 0x1f2800;
const INFO_SVC_MAX = 0x1f67ff;
const NETWORK_MIN = 0x1f6800;
const NETWORK_MAX = 0x1f77ff;
const TEMPORARY_MIN = 0x1f7800;
const TEMPORARY_MAX = 0x1f780f;
const OPER_MSG_MIN = 0x1f7810;
const OPER_MSG_MAX = 0x1f781f;
const RSVD2_MIN = 0x1f7820;
const RSVD2_MAX = 0x1f7ffe;
// Long-address inverse-formula constants (frame.h FLEX_LONG_*).
const LONG_W2_SET12 = 2097151;
const LONG_W2_SET34 = 1933312;
const LONG_W1_SET23 = 2064383;
const LONG_W2_SET23 = 1867776;
const LONG_OFFSET_A = 2068481;
const LONG_OFFSET_B = 2068479;

// Ordered [min, max, class, isLong] ranges, in the osmocom
// flex_classify_addr_word order (LA1, short, LA3, LA4, reserved, info-svc,
// network, temporary, oper-msg, reserved, LA2).
const ADDR_RANGES: ReadonlyArray<readonly [number, number, CapClass, boolean]> = [
	[LA1_MIN, LA1_MAX, 'long', true],
	[SHORT_ADDR_MIN, SHORT_ADDR_MAX, 'short', false],
	[LA3_MIN, LA3_MAX, 'long', true],
	[LA4_MIN, LA4_MAX, 'long', true],
	[RSVD1_MIN, RSVD1_MAX, 'reserved', false],
	[INFO_SVC_MIN, INFO_SVC_MAX, 'infoSvc', false],
	[NETWORK_MIN, NETWORK_MAX, 'network', false],
	[TEMPORARY_MIN, TEMPORARY_MAX, 'temporary', false],
	[OPER_MSG_MIN, OPER_MSG_MAX, 'operMsg', false],
	[RSVD2_MIN, RSVD2_MAX, 'reserved', false],
	[LA2_MIN, LA2_MAX, 'long', true],
];

/**
 * Classify a 21-bit address word into its capcode class. `long` marks the
 * two-word long-address components (LA1-LA4); every other class is a
 * single-word address. `unknown` (e.g. idle fill 0) is not a valid address.
 */
export function classifyAddress(aw: number): { capClass: CapClass; long: boolean } {
	for (const [min, max, capClass, long] of ADDR_RANGES) {
		if (aw >= min && aw <= max) return { capClass, long };
	}
	return { capClass: 'unknown', long: false };
}

/** Decode a short / special single-word address to its capcode. */
export function decodeShortAddress(aw: number): number {
	return aw - SHORT_ADDR_OFFSET;
}

/** Decode a long (2-word) address to its capcode, or 0 on an invalid set. */
export function decodeLongAddress(w1: number, w2: number): number {
	if (w1 >= LA1_MIN && w1 <= LA1_MAX && w2 >= LA2_MIN && w2 <= LA2_MAX) {
		return w1 + (LONG_W2_SET12 - w2) * SHORT_ADDR_OFFSET + (LONG_OFFSET_A - 1);
	}
	if (w1 >= LA1_MIN && w1 <= LA1_MAX && w2 >= LA3_MIN && w2 <= LA4_MAX) {
		return w1 + (w2 - LONG_W2_SET34) * SHORT_ADDR_OFFSET + (LONG_OFFSET_A - 1);
	}
	if (w1 >= LA2_MIN && w1 <= LA2_MAX && w2 >= LA3_MIN && w2 <= LA4_MAX) {
		return w1 - LONG_W1_SET23 + (w2 - LONG_W2_SET23) * SHORT_ADDR_OFFSET + LONG_OFFSET_B;
	}
	return 0;
}
