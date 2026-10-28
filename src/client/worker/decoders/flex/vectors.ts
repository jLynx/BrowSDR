/**
 * FLEX Short Message Vector (V=010) and HEX/Binary (V=110) decode. Faithful
 * ports of multimon-ng demod_flex_next.c parse_short_message / parse_binary.
 *
 * Short Message Vector (ARIB 3.9.2): a vector-type-2 is NOT a plain tone. It
 * carries a 2-bit sub-type (t1t0 in bits 7-8) and a 12-bit data field:
 *   t=00 numeric  -- 3 BCD digits (short) or 8 (long); all-space = tone-only
 *                    alert; on a Network address it is the Network-ID fields.
 *   t=01 source   -- a 3-bit source code.
 *   t=10 numbered -- source + message number N + retrieval R.
 *   t=11 reserved.
 *
 * HEX/Binary (ARIB 3.10.1.2): a continuous bit stream packed across 21-bit
 * words, nibbles extracted LSB-first and rendered as hex. On an initial
 * fragment the first body word is Header-2 (control: R/M/D/H/B/I/s/S), not
 * data, so it is skipped and the length reduced by one. Termination fill is
 * stripped from the final/complete fragment.
 */

import { BCD_TABLE } from './numeric';
import type { FlexMessage } from './types';
import type { CapClass, HexHeader } from './frame.types';

const FLEX_WORDS_PER_FRAME = 88;
const WORD_NOT_RECEIVED = 0;
const WORD_UNCORRECTABLE = 3;
const WORD_CORRECTED = 2;

function wordLost(status: number): boolean {
	return status === WORD_UNCORRECTABLE || status === WORD_NOT_RECEIVED;
}

const SMSG_SUBTYPE_SHIFT = 7;
const SMSG_SUBTYPE_MASK = 0x03;
const BCD_SPACE = 0x0c; // space fill nibble (tone-only detection)

/**
 * Decode a Short Message Vector (V=010) at vector index `j`. `capClass`
 * distinguishes a Network address (t=00 carries the Network-ID fields). The
 * second word of a long address holds 5 extra numeric digits (t=00).
 */
export function parseShortMessage(
	words: Uint32Array,
	status: Int8Array,
	j: number,
	isLong: boolean,
	capClass: CapClass,
	base: Omit<FlexMessage, 'kind' | 'text'>,
): FlexMessage {
	if (wordLost(status[j])) return { ...base, kind: 'SMSG', text: '' };
	const viw = words[j];
	const subType = (viw >> SMSG_SUBTYPE_SHIFT) & SMSG_SUBTYPE_MASK;
	if (subType === 0) return shortNumeric(words, status, j, viw, isLong, capClass, base);
	if (subType === 1) {
		const source = (viw >> 9) & 0x07;
		return { ...base, kind: 'SMSG:SRC', text: `SRC=${source}` };
	}
	if (subType === 2) {
		const source = (viw >> 9) & 0x07;
		const n = (viw >> 12) & 0x3f;
		const r = (viw >> 18) & 0x01;
		return { ...base, kind: 'SMSG:NUM', text: `SRC=${source}`, msgNumber: n, isNew: r === 1 };
	}
	// t=11 reserved.
	return { ...base, kind: 'SMSG:RSV', text: `RSVD t=${subType} d=0x${((viw >> 9) & 0xfff).toString(16).toUpperCase()}` };
}

/** t=00: short numeric (3 digits, +5 for long), Network-ID on a Network addr,
 * or a tone-only alert when every digit is space fill. */
function shortNumeric(
	words: Uint32Array,
	status: Int8Array,
	j: number,
	viw: number,
	isLong: boolean,
	capClass: CapClass,
	base: Omit<FlexMessage, 'kind' | 'text'>,
): FlexMessage {
	if (capClass === 'network') {
		const areaId = (viw >> 9) & 0x1f;
		const multiplier = (viw >> 14) & 0x07;
		const tmf = (viw >> 17) & 0x0f;
		return { ...base, kind: 'SMSG:NID', text: `area=${areaId} mult=${multiplier} tmf=0x${tmf.toString(16).toUpperCase()}` };
	}
	let digits = '';
	let allSpace = true;
	for (let i = 9; i <= 17; i += 4) {
		const d = (viw >> i) & 0x0f;
		digits += BCD_TABLE[d];
		if (d !== BCD_SPACE) allSpace = false;
	}
	if (isLong) {
		if (j + 1 < FLEX_WORDS_PER_FRAME && !wordLost(status[j + 1])) {
			const w2 = words[j + 1];
			for (let i = 0; i <= 16; i += 4) {
				const d = (w2 >> i) & 0x0f;
				digits += BCD_TABLE[d];
				if (d !== BCD_SPACE) allSpace = false;
			}
		} else {
			digits += '?????';
			allSpace = false;
		}
	}
	if (allSpace) return { ...base, kind: 'TONE', text: '' };
	return { ...base, kind: 'SMSG:NUM', text: digits };
}

const HEX_DIGITS = '0123456789ABCDEF';

/**
 * Build a HEX/Binary (or secure binary/vendor/reserved) message from its body
 * words and already-parsed fragment header. `hdrIdx` is the header word index
 * (mw1 short, Vy long); the body spans hdrIdx..mw2, with parseBinaryHex
 * skipping the Header-2 control word on an initial fragment. `kind` labels the
 * row (HEX, SECURE:BIN, SECURE:VEN, SECURE:RSV).
 */
export function hexMessage(
	words: Uint32Array,
	status: Int8Array,
	hdrIdx: number,
	mw2: number,
	hdr: HexHeader,
	kind: string,
	base: Omit<FlexMessage, 'kind' | 'text'>,
): FlexMessage {
	const complete = hdr.frag === 'K' || hdr.frag === ' ';
	const isInitial = hdr.hdrF === 3;
	const bodyLen = mw2 - hdrIdx + 1;
	const { text, charStatus } = parseBinaryHex(words, status, hdrIdx, bodyLen, isInitial, complete);
	return {
		...base,
		kind,
		text,
		charStatus,
		frag: hdr.frag,
		msgNum: hdr.msgNum,
		hdrF: hdr.hdrF,
		complete,
		mailDrop: hdr.mailDrop,
		retrieval: hdr.retrieval,
	};
}

/**
 * Decode a HEX/Binary body (V=110, or a secure binary/vendor/reserved payload)
 * into a hex string. `mw1` is the first body word, `len` the body word count,
 * `isInitial` true on the first fragment (whose first word is Header-2, skipped
 * and not data). `complete` (frag K or C) enables termination-fill stripping.
 */
export function parseBinaryHex(
	words: Uint32Array,
	status: Int8Array,
	mw1: number,
	len: number,
	isInitial: boolean,
	complete: boolean,
): { text: string; charStatus: number[] } {
	let dataStart = mw1;
	let dataLen = len;
	if (isInitial && dataLen > 0) {
		dataStart = mw1 + 1; // first body word is Header-2 (control only, no data)
		dataLen--;
	}

	const nibbles: string[] = [];
	const charStatus: number[] = [];
	let bitCount = 0;
	let acc = 0;
	for (let w = dataStart; w < dataStart + dataLen && w < FLEX_WORDS_PER_FRAME; w++) {
		const lost = wordLost(status[w]);
		const chStat = lost ? 2 : status[w] === WORD_CORRECTED ? 1 : 0;
		const dw = lost ? 0 : words[w];
		for (let b = 0; b < 21; b++) {
			const pos = bitCount & 3;
			if (pos === 0) acc = 0;
			if (!lost) acc |= ((dw >> b) & 1) << pos;
			if (pos === 3) {
				nibbles.push(lost ? '?' : HEX_DIGITS[acc & 0xf]);
				charStatus.push(chStat);
			}
			bitCount++;
		}
	}

	let count = nibbles.length;
	if (complete && dataLen > 0) count = stripTerminationFill(words, status, dataStart, dataLen, nibbles.length);
	return { text: nibbles.slice(0, count).join(''), charStatus: charStatus.slice(0, count) };
}

/**
 * Compute the real nibble count after stripping termination fill from the last
 * body word (ARIB 3.10.1.2 rules 2-3). Rule 3: an entirely-fill last word
 * (all-0 / all-1) is discarded whole. Rule 2: otherwise trailing identical bits
 * from bit 20 down are fill, and the first differing bit ends the real data.
 */
function stripTerminationFill(words: Uint32Array, status: Int8Array, dataStart: number, dataLen: number, nibbleCount: number): number {
	const lastW = dataStart + dataLen - 1;
	if (lastW >= FLEX_WORDS_PER_FRAME || wordLost(status[lastW])) return nibbleCount;

	// Rule 3: whole fill word at a word boundary.
	if (lastW > dataStart) {
		const lw = words[lastW] & 0x1fffff;
		if (lw === 0x000000 || lw === 0x1fffff) {
			const nibsBefore = ((lastW - dataStart) * 21) >> 2;
			if (nibsBefore > 0 && nibsBefore <= nibbleCount) return nibsBefore;
		}
	}

	// Rule 2: partial fill in the last word.
	const lw = words[lastW];
	const topBit = (lw >> 20) & 1;
	let fillStart = 21;
	for (let b = 20; b >= 0; b--) {
		if (((lw >> b) & 1) !== topBit) break;
		fillStart = b;
	}
	if (fillStart < 21 && fillStart > 0) {
		const realBits = (lastW - dataStart) * 21 + fillStart;
		const realNibbles = (realBits + 3) >> 2;
		if (realNibbles < nibbleCount) return realNibbles;
	}
	return nibbleCount;
}
