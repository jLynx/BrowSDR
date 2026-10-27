/* eslint-disable max-lines */
/**
 * FLEX frame-content decode: turn the four deinterleaved phase buffers of a
 * received frame into addressed messages. Single-frame decode of
 * a received FLEX frame into addressed messages.
 *
 * Per phase the decoder:
 *   1. BCH-decodes every 32-bit word to its 21-bit info field (with the
 *      integrate-and-dump alternate word as a fallback, region-aware).
 *   2. Reads BIW word 0 for the address-field and vector-field offsets.
 *   3. Walks the address field, classifying each word to a capcode
 *      (short/long/tone), pairing it with its vector word.
 *   4. Decodes the vector (type/start/length) and extracts the message:
 *      7-bit alphanumeric (alpha/secure) or 4-bit BCD numeric.
 *
 * Scope note: this is the single-frame core that yields real pages for the
 * dominant message types. Multi-transmission subframe combining, message
 * history / retransmission de-dup, and multi-frame fragment reassembly are
 * robustness layers documented as later phases in docs/flex-port-plan.md; a
 * message split across frames is reported as its received fragment.
 */

import { bchDecode, countBits } from './bch';
import { decodeBiws } from './biw';
import { combineSubframes } from './combine';
import { extractNumeric, numberedNumericMessage, verifyNumericKChecksum } from './numeric';
import { makeGroupSlots, foldGroupEvents, ageGroups, recordGroupEvent, tempSlotOf, describeInstruction } from './group';
import { classifyAddress, decodeShortAddress, decodeLongAddress } from './address';
import { parseShortMessage, hexMessage } from './vectors';
import { verifyKChecksum, alphaBodyWords } from './checksum';
import { extractKanji } from './kanji';
import { dedupVector, makeDedupStore } from './dedup';
import { makeFlexTimeVote, tickFlexTime, makeNetInfo } from './flextime';
import { partialMessage } from './reassembly';
import type { FlexPhaseData, FlexFiw, FlexMessage } from './types';
import type { Codepage } from '@/worker/decoders/charsets';
import type { ReasmSlot, FlexNetInfo, GroupEvent, GroupSlot, CapClass, HexHeader, DedupStore, FlexTimeVote } from './frame.types';

import {
	FLEX_WORDS_PER_FRAME,
	BCH_CODE_BITS,
	WORD_NOT_RECEIVED,
	WORD_CLEAN,
	WORD_CORRECTED,
	WORD_UNCORRECTABLE,
	VEC_SECURE,
	VEC_SHORT_INSTR,
	VEC_SHORT_MESSAGE,
	VEC_NUMERIC,
	VEC_SPECIAL_NUM,
	VEC_ALPHA,
	VEC_HEX_BINARY,
	VEC_NUMBERED_NUM,
	VEC_TYPE_SHIFT,
	VEC_TYPE_MASK,
	VEC_START_SHIFT,
	VEC_START_MASK,
	VEC_LEN_SHIFT,
	VEC_LEN_MASK,
	VEC_NUM_LEN_MASK,
	ALPHA_CHAR_MASK,
	ALPHA_ETX,
	ALPHA_SIG_MASK,
	ALPHA_HDR_C_SHIFT,
	ALPHA_HDR_F_SHIFT,
	ALPHA_HDR_N_SHIFT,
	ALPHA_HDR_R_SHIFT,
	ALPHA_HDR_M_SHIFT,
	HEX_HDR_C_SHIFT,
	HEX_HDR_F_SHIFT,
	HEX_HDR_N_SHIFT,
	SEC_TYPE_SHIFT,
	SEC_TYPE_MASK,
	SEC_TYPE_ALPHA,
	SEC_TYPE_BINARY,
} from './frame.types';
function wordLost(status: number): boolean {
	return status === WORD_UNCORRECTABLE || status === WORD_NOT_RECEIVED;
}

/**
 * BCH-decode every word of a phase buffer in place, preferring the primary
 * (majority-vote) word and falling back to the integrate-and-dump alternate.
 * Returns parallel arrays of 21-bit info words, their status, and the per-word
 * errored-bit count (Hamming distance BCH corrected, or a full codeword for an
 * uncorrectable word) for the bit-error-rate estimate. Mirrors the per-word
 * BCH + I&D merge (region-aware safety rule).
 */
function bchDecodePhase(ph: FlexPhaseData): { words: Uint32Array; status: Int8Array; errBits: Uint8Array } {
	const words = new Uint32Array(FLEX_WORDS_PER_FRAME);
	const status = new Int8Array(FLEX_WORDS_PER_FRAME);
	const errBits = new Uint8Array(FLEX_WORDS_PER_FRAME);

	// Pre-decode BIW word 0 for the address/vector offsets used by the
	// region-aware I&D safety rule.
	let biwAoffset = 1;
	let biwVoffset = FLEX_WORDS_PER_FRAME;
	if (!ph.receivedBits || ph.receivedBits[0] === 32) {
		const biw = bchDecode(ph.words[0]);
		if (biw.info >= 0) {
			const v = (biw.info >> 10) & 0x3f;
			biwAoffset = ((biw.info >> 8) & 0x03) + 1;
			if (v > 0) biwVoffset = v;
		}
	}

	for (let i = 0; i < FLEX_WORDS_PER_FRAME; i++) {
		// Zero-filled and partly shifted buffers are not received codewords.
		if (ph.receivedBits && ph.receivedBits[i] < 32) continue;
		const rawPrimary = ph.words[i];
		const primary = bchDecode(rawPrimary);
		if (primary.info >= 0) {
			words[i] = primary.info >>> 0;
			status[i] = primary.status === 0 ? WORD_CLEAN : WORD_CORRECTED;
			// Bits BCH flipped = Hamming distance over the 31-bit codeword.
			errBits[i] = countBits((rawPrimary ^ primary.corrected) & 0x7fffffff);
			continue;
		}
		// Primary failed: try the I&D alternate word.
		if (ph.altReceivedBits && ph.altReceivedBits[i] < 32) {
			words[i] = rawPrimary;
			status[i] = WORD_UNCORRECTABLE;
			errBits[i] = BCH_CODE_BITS;
			continue;
		}
		const alt = bchDecode(ph.altWords[i]);
		const inAddrRegion = i >= biwAoffset && i < biwVoffset;
		if (alt.info >= 0 && !inAddrRegion) {
			words[i] = alt.info >>> 0;
			status[i] = WORD_CORRECTED;
			errBits[i] = countBits((ph.altWords[i] ^ alt.corrected) & 0x7fffffff);
		} else if (alt.info >= 0 && alt.status === 0 && inAddrRegion) {
			// Address region: perfect alt BCH AND <= 1 raw-bit distance.
			const ndiff = popcount((rawPrimary ^ ph.altWords[i]) >>> 0);
			if (ndiff <= 1) {
				words[i] = alt.info >>> 0;
				status[i] = WORD_CORRECTED;
				errBits[i] = countBits((ph.altWords[i] ^ alt.corrected) & 0x7fffffff);
			} else {
				words[i] = rawPrimary;
				status[i] = WORD_UNCORRECTABLE;
				errBits[i] = BCH_CODE_BITS;
			}
		} else {
			words[i] = rawPrimary;
			status[i] = WORD_UNCORRECTABLE;
			errBits[i] = BCH_CODE_BITS;
		}
	}
	return { words, status, errBits };
}

function popcount(v: number): number {
	let d = v >>> 0;
	d = d - ((d >>> 1) & 0x55555555);
	d = (d & 0x33333333) + ((d >>> 2) & 0x33333333);
	d = (d + (d >>> 4)) & 0x0f0f0f0f;
	return ((d * 0x01010101) >>> 24) & 0xff;
}

/** Vector length in words: numeric uses a 3-bit n field, others 7-bit. */
function vectorLength(viw: number, vecType: number): number {
	if (vecType === VEC_NUMERIC || vecType === VEC_SPECIAL_NUM || vecType === VEC_NUMBERED_NUM) {
		return ((viw >> VEC_LEN_SHIFT) & VEC_NUM_LEN_MASK) + 1;
	}
	return (viw >> VEC_LEN_SHIFT) & VEC_LEN_MASK;
}

/**
 * Extract 7-bit alphanumeric text from the message words (alpha/secure). On an
 * initial fragment the first 7-bit slot (bits 0-6) of the first data word is
 * the message Signature, not a character (ARIB 3.8.8.3), so it is captured as
 * rxSig and skipped. Also accumulates sigSum = the running 7-bit sum of every
 * emitted character (ETX excluded), used to validate the signature. Mirrors
 * Alpha character extraction.
 */
function extractAlpha(
	words: Uint32Array,
	status: Int8Array,
	startWord: number,
	mw2: number,
	isInitial: boolean,
	cp?: Codepage,
): { text: string; sigSum: number; rxSig: number; wordsOk: boolean; charStatus: number[] } {
	let text = '';
	let sigSum = 0;
	let rxSig = 0;
	let wordsOk = true;
	const charStatus: number[] = [];
	for (let w = startWord; w <= mw2 && w < FLEX_WORDS_PER_FRAME; w++) {
		if (wordLost(status[w])) {
			// Lost word: on the initial fragment's signature word only 2 chars
			// would have been present, otherwise 3. A lost word means the
			// signature sum is incomplete and cannot be trusted.
			const lost = w === startWord && isInitial ? 2 : 3;
			text += '?'.repeat(lost);
			for (let k = 0; k < lost; k++) charStatus.push(2); // bad
			wordsOk = false;
			continue;
		}
		const dw = words[w];
		if (w === startWord && isInitial) rxSig = dw & ALPHA_SIG_MASK;
		// A BCH-corrected word's characters are recovered (status 1), a clean
		// word's are ok (status 0).
		const chStat = status[w] === WORD_CORRECTED ? 1 : 0;
		// First slot of the first data word on an initial fragment is the
		// signature, not a character.
		const firstShift = w === startWord && isInitial ? 7 : 0;
		for (let shift = firstShift; shift <= 14; shift += 7) {
			const ch = (dw >> shift) & ALPHA_CHAR_MASK;
			if (ch !== ALPHA_ETX) sigSum = (sigSum + ch) & ALPHA_SIG_MASK;
			if (ch !== ALPHA_ETX && ch !== 0) {
				// Map the 7-bit code through the selected codepage; null -> raw ASCII.
				text += (cp ? cp[ch & 0x7f] : null) ?? String.fromCharCode(ch);
				charStatus.push(chStat);
			}
		}
	}
	return { text, sigSum, rxSig, wordsOk, charStatus };
}

function vectorKind(vecType: number): string {
	switch (vecType) {
		case VEC_ALPHA:
			return 'ALPHA';
		case VEC_SECURE:
			return 'SECURE';
		case VEC_NUMERIC:
			return 'NUM';
		case VEC_SPECIAL_NUM:
			return 'SNUM';
		case VEC_NUMBERED_NUM:
			return 'NNUM';
		case VEC_SHORT_MESSAGE:
			return 'SMSG';
		case VEC_HEX_BINARY:
			return 'HEX';
		case VEC_SHORT_INSTR:
			return 'INSTR';
		default:
			return 'UNK';
	}
}

/** Sum errored bits and received-word bits into a bit-error-rate tally. */
function tallyWordErrors(status: Int8Array, errBits: Uint8Array, tally: { errBits: number; totalBits: number }): void {
	for (let w = 0; w < FLEX_WORDS_PER_FRAME; w++) {
		if (status[w] === WORD_NOT_RECEIVED) continue;
		tally.totalBits += BCH_CODE_BITS;
		tally.errBits += errBits[w];
	}
}

/**
 * Decode one phase buffer into zero or more messages. `phaseName` is 'A'..'D'.
 * Address/vector decode loop (single-frame).
 * When numTransmissions > 1 the in-frame subframe copies are best-of combined
 * before the address/vector walk.
 */
export function decodePhase(
	ph: FlexPhaseData,
	phaseName: string,
	fiw: FlexFiw,
	numTransmissions = 1,
	kanji = false,
	tally?: { errBits: number; totalBits: number },
	net?: FlexNetInfo,
	groupEvents?: GroupEvent[],
	dedup?: DedupStore,
	timeVote?: FlexTimeVote,
	frameMono = 0,
	cp?: Codepage,
): FlexMessage[] {
	const decoded = bchDecodePhase(ph);
	const { words, status } = combineSubframes(decoded.words, decoded.status, numTransmissions);
	const msgs: FlexMessage[] = [];

	// Bit-error-rate tally from the RAW per-word decode (pre-combine): errored
	// bits (BCH-corrected Hamming distance, or a full codeword if uncorrectable)
	// over received-word bits. Idle fill words are valid BCH codewords and
	// contribute 0 errored bits, so they do not inflate the rate.
	if (tally) tallyWordErrors(decoded.status, decoded.errBits, tally);

	// BIW word 0: aoffset = start of address field, voffset = start of vectors.
	if (wordLost(status[0])) return msgs;
	const biw = words[0];
	const aoffset = ((biw >> 8) & 0x03) + 1;
	const voffset = (biw >> 10) & 0x3f;
	if (voffset === 0 || voffset >= FLEX_WORDS_PER_FRAME) return msgs;

	// Decode any BIW network/temporal words (between BIW word 0 and the AF).
	if (net && timeVote) decodeBiws(words, status, aoffset, net, fiw, timeVote, frameMono);

	let addrIdx = aoffset;
	let vecCount = 0;
	while (addrIdx < voffset) {
		const j = voffset + vecCount; // vector index
		if (j >= FLEX_WORDS_PER_FRAME) break;
		const r = resolveAddress(words, status, addrIdx, voffset);
		if (r.skip) {
			// A skipped address (idle fill, unknown, or BCH-bad) has NO
			// corresponding vector word -- advance the address index only, never
			// the vector count (multimon-ng advances `i` but not `vec_used`).
			// Over-advancing vecCount here desyncs the vector index for every
			// later page, misreading their vector type (observed: dense mixed
			// long/short frames decoding later instruction vectors as secure).
			addrIdx += r.advance;
			continue;
		}
		addrIdx += r.advance;
		const msg = decodeVector(words, status, j, r.capcode, r.isLong, r.capClass, phaseName, fiw, kanji, dedup, cp);
		if (msg) {
			msg.capClass = r.capClass;
			msgs.push(msg);
		}
		// Group-messaging events (temp-slot tracker): a temporary-address message
		// is a delivery; a short-instruction type-000 vector assigns a member.
		if (groupEvents && !wordLost(status[j])) recordGroupEvent(words[j], r.capClass, r.capcode, groupEvents);
		vecCount += r.advance;
	}
	return msgs;
}

/** Resolve the address word(s) at addrIdx into a capcode + class, or signal a
 * skip. `advance` is how many address/vector slots this entry consumes (1 short,
 * 2 long). A lost/unknown/invalid word is skipped with the right advance. */
function resolveAddress(
	words: Uint32Array,
	status: Int8Array,
	addrIdx: number,
	voffset: number,
): { skip: boolean; advance: number; capcode: number; isLong: boolean; capClass: CapClass } {
	const miss = (advance: number) => ({ skip: true, advance, capcode: 0, isLong: false, capClass: 'unknown' as CapClass });
	if (wordLost(status[addrIdx])) return miss(1);
	const awBase = words[addrIdx];
	const { capClass, long: isLong } = classifyAddress(awBase);
	if (capClass === 'unknown') return miss(1);
	if (isLong) {
		if (addrIdx + 1 >= voffset || wordLost(status[addrIdx + 1])) return miss(2);
		const capcode = decodeLongAddress(awBase, words[addrIdx + 1]);
		if (capcode === 0) return miss(2);
		return { skip: false, advance: 2, capcode, isLong: true, capClass };
	}
	return { skip: false, advance: 1, capcode: decodeShortAddress(awBase), isLong: false, capClass };
}

/** Parse the alpha fragment header (F/C/N) at hdrIdx. Secure has no F field. */
function parseAlphaHeader(
	words: Uint32Array,
	status: Int8Array,
	hdrIdx: number,
	vecType: number,
): { frag: string; msgNum: number; hdrF: number; mailDrop: boolean; retrieval: boolean } {
	if (vecType !== VEC_ALPHA || hdrIdx >= FLEX_WORDS_PER_FRAME || wordLost(status[hdrIdx])) {
		return { frag: ' ', msgNum: -1, hdrF: 3, mailDrop: false, retrieval: false };
	}
	const hdr = words[hdrIdx];
	const hdrC = (hdr >> ALPHA_HDR_C_SHIFT) & 0x01;
	const hdrF = (hdr >> ALPHA_HDR_F_SHIFT) & 0x03;
	const msgNum = (hdr >> ALPHA_HDR_N_SHIFT) & 0x3f;
	let frag: string;
	if (hdrC === 0 && hdrF === 3)
		frag = 'K'; // complete/unfragmented
	else if (hdrC === 0)
		frag = 'C'; // final fragment
	else frag = 'F'; // continued (more follow)
	// R (bit 19) and M (bit 20) are valid on the FIRST fragment only (F=11).
	const initial = hdrF === 3;
	const retrieval = initial && ((hdr >> ALPHA_HDR_R_SHIFT) & 1) === 1;
	const mailDrop = initial && ((hdr >> ALPHA_HDR_M_SHIFT) & 1) === 1;
	return { frag, msgNum, hdrF, mailDrop, retrieval };
}

/** Parse the secure (V=000) sub-type from header bits 19-20, or -1 if n/a. */
function parseSecureType(words: Uint32Array, status: Int8Array, hdrIdx: number, vecType: number): number {
	if (vecType !== VEC_SECURE || hdrIdx >= FLEX_WORDS_PER_FRAME || wordLost(status[hdrIdx])) return -1;
	return (words[hdrIdx] >> SEC_TYPE_SHIFT) & SEC_TYPE_MASK;
}

/**
 * Secure (V=000) sub-type dispatch (header bits 19-20): 00=alpha; 10=binary;
 * 01=vendor; 11=reserved. Only 00 is 7-bit alphanumeric; every other sub-type
 * is decoded as a hex message. Returns the parsed message for a
 * non-alpha secure sub-type, or null to let the alpha path handle it.
 */
function secureBinaryMessage(
	words: Uint32Array,
	status: Int8Array,
	hdrIdx: number,
	mw1: number,
	mw2: number,
	isLong: boolean,
	vecType: number,
	hdr: HexHeader,
	base: Omit<FlexMessage, 'kind' | 'text'>,
): FlexMessage | null {
	if (vecType !== VEC_SECURE) return null;
	const secType = parseSecureType(words, status, hdrIdx, vecType);
	if (secType === SEC_TYPE_ALPHA || secType === -1) return null;
	const kindBin = secType === SEC_TYPE_BINARY ? 'SECURE:BIN' : secType === 1 ? 'SECURE:VEN' : 'SECURE:RSV';
	return hexMessage(words, status, isLong ? hdrIdx : mw1, mw2, hdr, kindBin, base);
}

/**
 * Decode an alpha/secure vector into a message. body[0] is the fragment header
 * (short addr at mw1, long addr at Vy=j+1); text starts at the word after it
 * (mw1+1 short, mw1 long, since mw2 already excludes body[0] for long). The
 * header carries F/C/N for alpha (secure uses bits 19-20 for sub-type).
 */
function decodeAlpha(
	words: Uint32Array,
	status: Int8Array,
	j: number,
	mw1: number,
	mw2: number,
	isLong: boolean,
	vecType: number,
	base: Omit<FlexMessage, 'kind' | 'text'>,
	kind: string,
	kanji: boolean,
	cp?: Codepage,
): FlexMessage {
	const hdrIdx = isLong ? j + 1 : mw1;
	const hdr = parseAlphaHeader(words, status, hdrIdx, vecType);
	const { frag, msgNum, hdrF, mailDrop, retrieval } = hdr;
	const complete = frag === 'K' || frag === ' ';

	// Secure (V=000) non-alpha sub-types (binary/vendor/reserved) decode as hex.
	const secBin = secureBinaryMessage(words, status, hdrIdx, mw1, mw2, isLong, vecType, hdr, base);
	if (secBin) return secBin;
	let kindOut = kind;
	if (vecType === VEC_SECURE) kindOut = 'SECURE:ALN';

	// Initial fragment (F=11): the first data word's slot-0 is the signature.
	const isInitial = vecType === VEC_ALPHA && hdrF === 3;
	const startWord = isLong ? mw1 : mw1 + 1;
	const endWord = mw2; // mw2 was already adjusted (mw2-- for long) so it's consistent for both

	const isKanji = kanji && vecType === VEC_ALPHA;
	const payload = extractAlphaPayload(words, status, startWord, endWord, isInitial, vecType, isKanji, cp);
	if (isKanji && kindOut === 'ALPHA') kindOut = 'ALPHA:KNJ';
	const { text, sigSum, rxSig, wordsOk, charStatus } = payload;

	// K checksum (per-fragment, alpha only).
	const kOk = vecType === VEC_ALPHA ? verifyKChecksum(words, status, hdrIdx, alphaBodyWords(hdrIdx, mw1, mw2, isLong)) : null;

	// Signature: validate now for a complete 7-bit message; a fragment's
	// signature spans all fragments, so defer to reassembly completion (carry
	// rxSig/sigSum/sigValid). sigOk null = n/a, deferred, Kanji/binary, or a
	// lost word made the signature sum incomplete (osmocom sig=incomplete).
	let sigOk: boolean | null = null;
	if (vecType === VEC_ALPHA && !isKanji && complete && isInitial) {
		sigOk = wordsOk ? rxSig === (~sigSum & ALPHA_SIG_MASK) : null;
	}
	return {
		...base,
		kind: kindOut,
		text,
		frag,
		msgNum,
		complete,
		kOk,
		sigOk,
		rxSig,
		sigSum,
		sigValid: wordsOk,
		mailDrop,
		retrieval,
		charStatus,
		hdrF,
	};
}

/**
 * Extract the alpha payload by the selected path: Kanji (16-bit, alpha only) or
 * 7-bit text. Only the 7-bit path yields a meaningful signature sum / received
 * signature; Kanji returns defaults. (Secure binary is decoded upstream.)
 */
function extractAlphaPayload(
	words: Uint32Array,
	status: Int8Array,
	startWord: number,
	endWord: number,
	isInitial: boolean,
	vecType: number,
	isKanji: boolean,
	cp?: Codepage,
): { text: string; sigSum: number; rxSig: number; wordsOk: boolean; charStatus: number[] } {
	if (isKanji) {
		const kanji = extractKanji(words, status, startWord, endWord, isInitial);
		return { text: kanji.text, sigSum: 0, rxSig: 0, wordsOk: kanji.wordsOk, charStatus: [] };
	}
	return extractAlpha(words, status, startWord, endWord, isInitial, cp);
}

function decodeVector(
	words: Uint32Array,
	status: Int8Array,
	j: number,
	capcode: number,
	isLong: boolean,
	capClass: CapClass,
	phaseName: string,
	fiw: FlexFiw,
	kanji: boolean,
	dedup?: DedupStore,
	cp?: Codepage,
): FlexMessage | null {
	if (wordLost(status[j])) return null;
	const viw = words[j];
	const vecType = (viw >> VEC_TYPE_SHIFT) & VEC_TYPE_MASK;
	const mw1 = (viw >> VEC_START_SHIFT) & VEC_START_MASK;
	const len = vectorLength(viw, vecType);
	let mw2 = mw1 + (len - 1);
	// Long address: body[0] sits at Vy (j+1); MF range covers body[1..].
	if (isLong && len > 0 && vecType !== VEC_SHORT_INSTR && vecType !== VEC_SHORT_MESSAGE) mw2--;

	// Word-level dedup / combine for complete (K) messages: may redirect the
	// decode to a cleaner merged word set and tag the message DUP / DUP+.
	let dw = words;
	let ds = status;
	let dedupTag: 'dup' | 'dup+' | undefined;
	if (dedup) {
		const d = dedupVector(dedup, words, status, j, mw1, len, vecType, isLong, capcode, fiw.cycle * 128 + fiw.frame);
		dw = d.words;
		ds = d.status;
		dedupTag = d.tag;
	}

	const base: Omit<FlexMessage, 'kind' | 'text'> = {
		capcode,
		phase: phaseName,
		cycle: fiw.cycle,
		frame: fiw.frame,
		vectorType: vecType,
		long: isLong,
		frag: ' ',
		msgNum: -1,
		complete: true,
	};
	const kind = vectorKind(vecType);

	const msg = dispatchVector(dw, ds, j, mw1, mw2, isLong, capClass, vecType, kind, base, kanji, cp);
	if (msg && dedupTag) msg.dedup = dedupTag;
	return msg;
}

/** Dispatch a vector to its type-specific decoder (post-dedup word set). */
function dispatchVector(
	words: Uint32Array,
	status: Int8Array,
	j: number,
	mw1: number,
	mw2: number,
	isLong: boolean,
	capClass: CapClass,
	vecType: number,
	kind: string,
	base: Omit<FlexMessage, 'kind' | 'text'>,
	kanji: boolean,
	cp?: Codepage,
): FlexMessage | null {
	if (vecType === VEC_SHORT_MESSAGE) {
		return parseShortMessage(words, status, j, isLong, capClass, base);
	}
	if (vecType === VEC_ALPHA || vecType === VEC_SECURE) {
		return decodeAlpha(words, status, j, mw1, mw2, isLong, vecType, base, kind, kanji, cp);
	}
	if (vecType === VEC_NUMERIC || vecType === VEC_SPECIAL_NUM || vecType === VEC_NUMBERED_NUM) {
		return decodeNumericVector(words, status, j, mw1, mw2, isLong, vecType, base, kind);
	}
	if (vecType === VEC_HEX_BINARY) {
		return decodeHex(words, status, j, mw1, mw2, isLong, base);
	}
	// Short-instruction (V=001): describe the instruction (group setup / system
	// event) as readable text instead of an empty body.
	if (vecType === VEC_SHORT_INSTR) {
		return { ...base, kind, text: describeInstruction(words[j]) };
	}
	// Any other vector: not extracted here.
	return { ...base, kind, text: '' };
}

/** Decode a numeric vector (standard / special / numbered). body[0] is at Vy
 * (j+1) for a long address, else the message-field words start at mw1. */
function decodeNumericVector(
	words: Uint32Array,
	status: Int8Array,
	j: number,
	mw1: number,
	mw2: number,
	isLong: boolean,
	vecType: number,
	base: Omit<FlexMessage, 'kind' | 'text'>,
	kind: string,
): FlexMessage | null {
	if (mw1 > 87 || mw2 > 87) return null;
	const wordIdx: number[] = isLong && j + 1 < FLEX_WORDS_PER_FRAME ? [j + 1] : [];
	for (let w = mw1; w <= mw2; w++) wordIdx.push(w);
	const text = extractNumeric(words, status, wordIdx, vecType);
	const kOk = verifyNumericKChecksum(words, status, words[j], wordIdx); // 6-bit K (ARIB 3.10.1.1.1)
	if (vecType === VEC_NUMBERED_NUM) {
		const hdrIdx = isLong ? j + 1 : mw1;
		return { ...numberedNumericMessage(words, status, hdrIdx, base, text), kOk };
	}
	return { ...base, kind, text, kOk };
}

/**
 * Decode a HEX/Binary (V=110) vector. The hdr1 word (at mw1 short, Vy=j+1 long)
 * carries F/C/N fragment fields at HEX-specific bit positions (K is 12-bit,
 * so F/C/N are 2 bits higher than in the alpha header). Multi-fragment
 * HEX reassembles through the shared reassembler via frag/msgNum/hdrF.
 */
function decodeHex(
	words: Uint32Array,
	status: Int8Array,
	j: number,
	mw1: number,
	mw2: number,
	isLong: boolean,
	base: Omit<FlexMessage, 'kind' | 'text'>,
): FlexMessage {
	const hdrIdx = isLong ? j + 1 : mw1;
	// HEX header-1 uses different bit positions from alpha (12-bit K vs 10-bit K).
	let hdr: HexHeader;
	if (hdrIdx >= FLEX_WORDS_PER_FRAME || wordLost(status[hdrIdx])) {
		hdr = { frag: ' ', msgNum: -1, hdrF: 3, mailDrop: false, retrieval: false };
	} else {
		const w = words[hdrIdx];
		const hdrC = (w >> HEX_HDR_C_SHIFT) & 0x01;
		const hdrF = (w >> HEX_HDR_F_SHIFT) & 0x03;
		const msgNum = (w >> HEX_HDR_N_SHIFT) & 0x3f;
		let frag: string;
		if (hdrC === 0 && hdrF === 3)
			frag = 'K'; // complete/unfragmented
		else if (hdrC === 0)
			frag = 'C'; // final fragment
		else frag = 'F'; // continued
		// R and M live in header-2 for HEX (not header-1), so always false here.
		hdr = { frag, msgNum, hdrF, mailDrop: false, retrieval: false };
	}
	return hexMessage(words, status, isLong ? hdrIdx : mw1, mw2, hdr, 'HEX', base);
}

/**
 * Decode a completed frame's phase buffers into messages. `activePhases` lists
 * the phase-buffer indices to decode (A1:[0], A2/A3:[0,2], A4:[0,1,2,3]).
 * Phase dispatch — decodes active phases for the given air mode.
 *
 * This is the stateless single-frame entry (no multi-transmission combine, no
 * cross-frame reassembly). For those robustness layers use FlexFrameDecoder.
 */
export function decodeFrame(phases: FlexPhaseData[], activePhases: number[], fiw: FlexFiw): FlexMessage[] {
	const names = ['A', 'B', 'C', 'D'];
	const out: FlexMessage[] = [];
	for (const pi of activePhases) {
		out.push(...decodePhase(phases[pi], names[pi], fiw));
	}
	return out;
}

// -- Fragment reassembly (ARIB STD-43A 3.10.1.3) -----------------------------

// Fragment reassembly slots (multimon-ng FLEX_FRAG_MAX_SLOTS = 64).
const REASM_SLOTS = 64;
// Up to 128 frames between fragments on shared channels (spec Section 4.2;
// matches multimon-ng FLEX_FRAG_TIMEOUT). Age is on the mod-1920 absolute frame.
const REASM_TIMEOUT_FRAMES = 128;

/**
 * Stateful FLEX frame decoder: wraps the stateless per-phase decode with the
 * two robustness layers osmocom applies on top of it --
 *   1. multi-transmission subframe combining (best-of across in-frame copies);
 *   2. cross-frame fragment reassembly for alpha messages (F/C/N).
 * Construct once per decode session; feed each completed frame to decode().
 * A non-fragmented message passes straight through; a fragment is held until
 * its final piece arrives, then emitted whole with complete=true.
 */
export class FlexFrameDecoder {
	// Reassembly slots per polarity (0 = normal, 1 = inverted).
	private readonly slots: ReasmSlot[][] = [[], []];
	// When the selected FLEX charset is Kanji, alpha payloads are decoded as
	// 16-bit Shift-JIS (set by the caller from the charset key, not auto-detected).
	private readonly kanji: boolean;
	// Selected 7-bit glyph codepage for plain alpha (vendor charset). Undefined
	// = raw ASCII. Not used on the Kanji path (that is a 16-bit handler charset).
	private readonly cp?: Codepage;
	// Smoothed bit-error rate (errored bits over received codeword bits:
	// BCH-corrected Hamming distance, or a full codeword if uncorrectable),
	// updated each decoded frame; null until the first frame.
	private ber: number | null = null;
	// Network/temporal info accumulated from BIW words across frames.
	private readonly net: FlexNetInfo = makeNetInfo();
	// Consistency-voting state for the over-the-air clock, per polarity.
	private readonly timeVote: FlexTimeVote[] = [makeFlexTimeVote(), makeFlexTimeVote()];
	// Temporary-address (group) slot state per polarity: [pol][16 slots].
	private readonly groups: GroupSlot[][] = [makeGroupSlots(), makeGroupSlots()];
	// Word-level dedup / combine cache per polarity (32 slots each).
	private readonly dedup: DedupStore[] = [makeDedupStore(), makeDedupStore()];
	// Partials abandoned mid-frame (superseded by a new initial fragment for the
	// same capcode); drained into the frame output after the decode loop.
	private pendingAbandoned: FlexMessage[] = [];

	constructor(kanji = false, cp?: Codepage) {
		this.kanji = kanji;
		this.cp = cp;
	}

	/** Last smoothed bit-error rate (0..1), or null before the first frame. */
	getBer(): number | null {
		return this.ber;
	}

	/** Reset BER to null (called on sync loss so hunt state reports no BER). */
	resetBer(): void {
		this.ber = null;
	}

	/** Reset network time/date info (called on sync loss so stale time doesn't
	 * persist from a previous transmission into the new lock). */
	resetNet(): void {
		this.net.time = null;
		this.net.date = null;
		this.net.tzOffsetMin = null;
		this.net.dst = null;
		this.net.clock = null;
	}

	/** Accumulated network/temporal info from BIW words. */
	getNetInfo(): FlexNetInfo {
		return this.net;
	}

	/** Temporary-address (group) slot state for a polarity (0 normal, 1 inv). */
	getGroupSlots(polarity: number): GroupSlot[] {
		return this.groups[polarity & 1];
	}

	/** In-flight fragment reassembly buffer count for a polarity. */
	getReasmCount(polarity: number): number {
		return this.slots[polarity & 1].length;
	}

	/** Decode one completed frame, applying combine + reassembly. */
	decode(phases: FlexPhaseData[], activePhases: number[], fiw: FlexFiw, polarity: number): FlexMessage[] {
		const pol = polarity & 1;
		const frameAbs = fiw.cycle * 128 + fiw.frame;
		// Advance the monotonic clock counter and expire stale flextime.
		const frameMono = tickFlexTime(this.timeVote[pol], this.net, frameAbs);
		const out: FlexMessage[] = this.expire(polarity, frameAbs);
		this.ageGroups(polarity, frameAbs);

		const names = ['A', 'B', 'C', 'D'];
		const tally = { errBits: 0, totalBits: 0 };
		const groupEvents: GroupEvent[] = [];
		for (const pi of activePhases) {
			for (const msg of decodePhase(
				phases[pi],
				names[pi],
				fiw,
				fiw.numTransmissions,
				this.kanji,
				tally,
				this.net,
				groupEvents,
				this.dedup[pol],
				this.timeVote[pol],
				frameMono,
				this.cp,
			)) {
				const assembled = this.reassemble(msg, polarity, frameAbs);
				if (assembled) {
					assembled.inverted = (polarity & 1) === 1;
					// Group delivery: attach the member capcodes learned from the
					// slot's earlier short-instruction assignments (the delivery
					// message itself carries only the temporary address).
					if (assembled.capClass === 'temporary') {
						assembled.groupMembers = this.groups[polarity & 1][tempSlotOf(assembled.capcode)].members.slice();
					}
					out.push(assembled);
				}
			}
		}
		// Emit any partials abandoned mid-frame (superseded by a new stream).
		if (this.pendingAbandoned.length) {
			out.push(...this.pendingAbandoned);
			this.pendingAbandoned = [];
		}
		this.foldGroupEvents(polarity, frameAbs, groupEvents);
		// Update the smoothed bit-error rate (EMA) from this frame's tally.
		if (tally.totalBits > 0) {
			const frameBer = tally.errBits / tally.totalBits;
			this.ber = this.ber === null ? frameBer : this.ber * 0.7 + frameBer * 0.3;
			if (import.meta.env.DEV)
				console.log(
					`[FLEX FRAME_BER] frame_ber=${(frameBer * 100).toFixed(2)}% smooth_ber=${(this.ber * 100).toFixed(2)}% errBits=${tally.errBits} totalBits=${tally.totalBits}`,
				);
		}
		return out;
	}

	reset(): void {
		this.slots[0] = [];
		this.slots[1] = [];
		this.ber = null;
		this.groups[0] = makeGroupSlots();
		this.groups[1] = makeGroupSlots();
		this.dedup[0] = makeDedupStore();
		this.dedup[1] = makeDedupStore();
		this.timeVote[0] = makeFlexTimeVote();
		this.timeVote[1] = makeFlexTimeVote();
	}

	/** Apply this frame's group events to the polarity's slot state. */
	private foldGroupEvents(polarity: number, frameAbs: number, events: GroupEvent[]): void {
		foldGroupEvents(this.groups[polarity & 1], frameAbs, events);
	}

	/** Age group slots back to idle after a quiet window. */
	private ageGroups(polarity: number, frameAbs: number): void {
		ageGroups(this.groups[polarity & 1], frameAbs);
	}

	/** Find or create the reassembly slot for capcode+N, abandoning any other
	 * active stream for the same capcode (superseded -> incomplete partial). */
	private acquireSlot(pol: number, capcode: number, type: number, n: number, reasmKey: string, frameAbs: number): ReasmSlot {
		const found = this.slots[pol].find((s) => s.capcode === capcode && s.type === type && s.msgNum === n);
		if (found) return found;
		// A new stream for the same capcode+type with a different N supersedes an
		// older one — emit incomplete.
		for (const other of this.slots[pol].filter((s) => s.capcode === capcode && s.type === type && s.msgNum !== n)) {
			this.pendingAbandoned.push(partialMessage(other, pol));
		}
		this.slots[pol] = this.slots[pol].filter((s) => !(s.capcode === capcode && s.type === type && s.msgNum !== n));
		if (this.slots[pol].length >= REASM_SLOTS) {
			let oldest = 0;
			for (let i = 1; i < this.slots[pol].length; i++) {
				if (this.slots[pol][i].lastFrameAbs < this.slots[pol][oldest].lastFrameAbs) oldest = i;
			}
			this.slots[pol].splice(oldest, 1);
		}
		const slot: ReasmSlot = {
			capcode,
			type,
			msgNum: n,
			text: '',
			charStatus: [],
			fragCount: 0,
			expectedF: 0,
			fMismatch: false,
			reasmKey,
			lastFrameAbs: frameAbs,
			rxSig: -1,
			sigSum: 0,
			sigValid: true,
		};
		this.slots[pol].push(slot);
		return slot;
	}

	/** F mod-3 sequence check (multimon-ng): initial fragment is F=3; continued
	 * fragments run 0,1,2,0,1,2... A jump means a lost fragment -- flag it and
	 * insert a visible gap marker. */
	private checkFragSequence(slot: ReasmSlot, hdrF: number): void {
		if (hdrF === 3) {
			slot.expectedF = 0;
			return;
		}
		if (hdrF !== slot.expectedF) {
			slot.fMismatch = true;
			slot.text += '<...>';
			for (let k = 0; k < 5; k++) slot.charStatus.push(2);
		}
		slot.expectedF = (hdrF + 1) % 3;
	}

	/** Feed one decoded message through the reassembler. */
	private reassemble(msg: FlexMessage, polarity: number, frameAbs: number): FlexMessage | null {
		// Only alpha fragments ('F' continued, 'C' final) reassemble; anything
		// else (complete alpha, numeric, tone, secure) passes straight through.
		if (msg.frag !== 'F' && msg.frag !== 'C') return msg;

		const pol = polarity & 1;
		const n = msg.msgNum ?? -1;
		const type = msg.vectorType;
		const reasmKey = `${pol}:${msg.capcode}:${type}:${n}`;
		const slot = this.acquireSlot(pol, msg.capcode, type, n, reasmKey, frameAbs);
		this.checkFragSequence(slot, msg.hdrF ?? 3);
		slot.text += msg.text;
		if (msg.charStatus) slot.charStatus.push(...msg.charStatus);
		slot.fragCount++;
		slot.lastFrameAbs = frameAbs;
		// Accumulate the signature sum across fragments; the received signature
		// rides on the initial fragment (F=11, C=1), which extractAlpha captured
		// as msg.rxSig. Record it the first time we see a non-zero value.
		slot.sigSum = (slot.sigSum + (msg.sigSum ?? 0)) & 0x7f;
		if (slot.rxSig < 0 && msg.rxSig !== undefined && msg.rxSig > 0) slot.rxSig = msg.rxSig;
		if (msg.sigValid === false) slot.sigValid = false;

		if (msg.frag === 'C') {
			// Final fragment: validate the whole-message signature, emit, release.
			// A detected F-sequence gap means a middle fragment was lost -- the
			// message is still emitted (valid partial) but flagged incomplete.
			const text = slot.text;
			const charStatus = slot.charStatus;
			const fragCount = slot.fragCount;
			const fMismatch = slot.fMismatch;
			const sigOk = slot.sigValid && slot.rxSig >= 0 ? slot.rxSig === (~slot.sigSum & 0x7f) : null;
			this.slots[pol] = this.slots[pol].filter((s) => s !== slot);
			return { ...msg, text, charStatus, complete: true, sigOk, reasmKey, fragCount, incomplete: fMismatch };
		}
		// Continued fragment: emit an in-place partial so the UI shows the
		// message building up (dimmed PARTIAL row updated by reasmKey), rather
		// than holding it invisibly until the final fragment arrives.
		return { ...msg, text: slot.text, charStatus: [...slot.charStatus], complete: false, reasmKey, fragCount: slot.fragCount };
	}

	/** Expire reassembly slots past the timeout, returning each abandoned slot
	 * as an incomplete (but valid) partial message for the UI to print. */
	private expire(polarity: number, frameAbs: number): FlexMessage[] {
		const pol = polarity & 1;
		const kept: ReasmSlot[] = [];
		const abandoned: FlexMessage[] = [];
		for (const s of this.slots[pol]) {
			const age = (frameAbs - s.lastFrameAbs + 1920) % 1920;
			if (age < REASM_TIMEOUT_FRAMES) kept.push(s);
			else abandoned.push(partialMessage(s, pol));
		}
		this.slots[pol] = kept;
		return abandoned;
	}
}

export { ALPHA_SIG_MASK };
export type { FlexMessage } from './types';
