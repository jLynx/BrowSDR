/**
 * FLEX message deduplication + word-level combining for complete (K) messages.
 *
 * A faithful port of multimon-ng demod_flex_next.c dedup_check_words. Stores
 * the packed raw words (header + body) of each complete message with their
 * BCH lost-status, keyed by (capcode, type, msgNum, wordCount). On a
 * retransmission:
 *   - every stored-clean word must match the new word (else it is a different
 *     message, not a duplicate);
 *   - a word that was lost in the cache but clean now is an improvement: the
 *     cleaner word is merged into the cache and the message is re-decoded from
 *     the merged set (so a page corrupted in one transmission can be recovered
 *     from a cleaner retransmission);
 *   - an exact match with no improvement is a duplicate.
 *
 * Duplicates are TAGGED, not dropped -- the caller still emits the message with
 * a dedup marker so the operator sees the retransmission happened.
 */

import type { DedupStore, DedupEntry, DedupResult, DedupOutcome } from './frame.types';

const DEDUP_SLOTS = 32;
const DEDUP_TIMEOUT_FRAMES = 128; // cache entry lifetime, like the reassembly window
const DEDUP_MAX_WORDS = 88; // hdr + body ceiling (one phase of 88 words)
const FRAME_CYCLE_MOD = 1920; // 15 cycles x 128 frames, for rollover-safe aging

// Word status values shared with the frame decoder (frame.h flex_word_status).
const WORD_CLEAN = 1;
const WORD_UNCORRECTABLE = 3;

function wordIsLost(status: number): boolean {
	return status === WORD_UNCORRECTABLE || status === 0; // uncorrectable or not-received
}

/** Build an empty dedup store (32 inactive slots). */
export function makeDedupStore(): DedupStore {
	const entries: DedupEntry[] = [];
	for (let i = 0; i < DEDUP_SLOTS; i++) {
		entries.push({
			active: false,
			capcode: 0,
			type: 0,
			msgNum: 0,
			wordCount: 0,
			words: new Uint32Array(DEDUP_MAX_WORDS),
			lost: new Uint8Array(DEDUP_MAX_WORDS),
			frameSeen: 0,
		});
	}
	return { entries, nextSlot: 0 };
}

/**
 * Check a complete message's packed words against the cache. `packedWords` /
 * `packedLost` are [hdr, body0, body1, ...] (length `wordCount`). `frameAbs` is
 * the absolute frame (cycle*128+frame). Returns:
 *   - { kind: 'new' }       -- not seen; cached; caller decodes normally.
 *   - { kind: 'dup' }       -- exact duplicate; caller tags and still emits.
 *   - { kind: 'improved' }  -- cleaner retransmission; words/lost carry the
 *                              merged packed set for the caller to re-decode.
 */
export function dedupCheck(
	store: DedupStore,
	capcode: number,
	type: number,
	msgNum: number,
	packedWords: Uint32Array,
	packedLost: Uint8Array,
	wordCount: number,
	frameAbs: number,
): DedupResult {
	const n = Math.min(wordCount, DEDUP_MAX_WORDS);

	for (const e of store.entries) {
		if (!e.active) continue;
		const age = (frameAbs - e.frameSeen + FRAME_CYCLE_MOD) % FRAME_CYCLE_MOD;
		if (age > DEDUP_TIMEOUT_FRAMES) {
			e.active = false;
			continue;
		}
		if (e.capcode !== capcode || e.type !== type || e.msgNum !== msgNum || e.wordCount !== n) continue;

		const cmp = compareEntry(e, packedWords, packedLost, n);
		if (cmp === 'different') continue;
		if (cmp === 'duplicate') return { kind: 'dup' };

		// Improved: merge each newly-clean word into the cache, then return the
		// merged packed set for re-decode.
		for (let w = 0; w < n; w++) {
			if (e.lost[w] && !packedLost[w]) {
				e.words[w] = packedWords[w];
				e.lost[w] = 0;
			}
		}
		e.frameSeen = frameAbs;
		return { kind: 'improved', words: e.words.slice(0, n), lost: e.lost.slice(0, n) };
	}

	insertEntry(store, capcode, type, msgNum, packedWords, packedLost, n, frameAbs);
	return { kind: 'new' };
}

/**
 * Word-level comparison of a candidate against a cache entry:
 *   both clean, same value  -> match
 *   both clean, diff value  -> different message
 *   cached clean, new lost   -> match (new is worse)
 *   cached lost, new clean   -> improvement
 *   both lost                -> match (both unknown)
 */
function compareEntry(e: DedupEntry, words: Uint32Array, lost: Uint8Array, n: number): 'different' | 'duplicate' | 'improved' {
	let improved = false;
	for (let w = 0; w < n; w++) {
		const cachedLost = e.lost[w];
		const newLost = lost[w];
		if (!cachedLost && !newLost) {
			if (e.words[w] !== words[w]) return 'different';
		} else if (cachedLost && !newLost) {
			improved = true;
		}
	}
	return improved ? 'improved' : 'duplicate';
}

/** Insert a new entry at the round-robin slot (overwrites the oldest in rotation). */
function insertEntry(
	store: DedupStore,
	capcode: number,
	type: number,
	msgNum: number,
	words: Uint32Array,
	lost: Uint8Array,
	n: number,
	frameAbs: number,
): void {
	const slot = store.nextSlot;
	const e = store.entries[slot];
	e.active = true;
	e.capcode = capcode;
	e.type = type;
	e.msgNum = msgNum;
	e.wordCount = n;
	e.frameSeen = frameAbs;
	for (let w = 0; w < n; w++) {
		e.words[w] = words[w];
		e.lost[w] = lost[w];
	}
	store.nextSlot = (slot + 1) % DEDUP_SLOTS;
}

/**
 * Run the dedup/combine for a complete message. Packs [hdr, body0..body(n-1)]
 * from the live phase arrays (reference order), checks the cache, and on an
 * improved retransmission writes the merged cleaner words into FRESH copies of
 * the word/status arrays (leaving the live buffers untouched) for the decoder
 * to re-run. `hdrIdx` is the header word index, `bodyStart` the first body
 * word, `bodyLen` the body word count (all in frame coordinates).
 */
export function dedupMessage(
	store: DedupStore,
	words: Uint32Array,
	status: Int8Array,
	hdrIdx: number,
	bodyStart: number,
	bodyLen: number,
	type: number,
	msgNum: number,
	capcode: number,
	frameAbs: number,
): DedupOutcome {
	const n = 1 + bodyLen;
	const packedWords = new Uint32Array(n);
	const packedLost = new Uint8Array(n);
	packedWords[0] = words[hdrIdx];
	packedLost[0] = wordIsLost(status[hdrIdx]) ? 1 : 0;
	for (let w = 0; w < bodyLen; w++) {
		const idx = bodyStart + w;
		packedWords[1 + w] = words[idx];
		packedLost[1 + w] = wordIsLost(status[idx]) ? 1 : 0;
	}

	const res = dedupCheck(store, capcode, type, msgNum, packedWords, packedLost, n, frameAbs);
	if (res.kind === 'new') return { words, status };
	if (res.kind === 'dup') return { words, status, tag: 'dup' };

	const mergedWords = words.slice();
	const mergedStatus = status.slice();
	mergedWords[hdrIdx] = res.words[0];
	mergedStatus[hdrIdx] = res.lost[0] ? WORD_UNCORRECTABLE : WORD_CLEAN;
	for (let w = 0; w < bodyLen; w++) {
		mergedWords[bodyStart + w] = res.words[1 + w];
		mergedStatus[bodyStart + w] = res.lost[1 + w] ? WORD_UNCORRECTABLE : WORD_CLEAN;
	}
	return { words: mergedWords, status: mergedStatus, tag: 'dup+' };
}

// Vector types needed for the dedup gate (frame.h FLEX_VECTOR_TYPE_*).
const VEC_SHORT_INSTR = 0x1;
const VEC_SHORT_MESSAGE = 0x2;
const VEC_HEX_BINARY = 0x6;
const PHASE_WORDS = 88;

/**
 * Dedup gate + word-combine for a complete (K) message. Resolves the header
 * word index and body range in the reference's packed layout (hdr at Vy=j+1 for
 * long, mw1 for short; body follows), reads the fragment flags to confirm the
 * message is complete, and runs dedupMessage. SMSG, short-instruction and
 * fragments decode normally (no dedup). Returns the possibly-merged word set
 * and a tag. A lost header word cannot be keyed, so it decodes normally.
 */
export function dedupVector(
	store: DedupStore,
	words: Uint32Array,
	status: Int8Array,
	j: number,
	mw1: number,
	len: number,
	vecType: number,
	isLong: boolean,
	capcode: number,
	frameAbs: number,
): DedupOutcome {
	const plain: DedupOutcome = { words, status };
	const hdrIdx = isLong ? j + 1 : mw1;
	const bodyStart = isLong ? mw1 : mw1 + 1;
	const bodyLen = len - 1;
	if (bodyLen <= 0 || hdrIdx >= PHASE_WORDS || bodyStart + bodyLen > PHASE_WORDS) return plain;
	if (vecType === VEC_SHORT_MESSAGE || vecType === VEC_SHORT_INSTR) return plain;
	if (wordIsLost(status[hdrIdx])) return plain;

	const h = words[hdrIdx];
	let complete: boolean;
	let msgNum: number;
	if (vecType === VEC_HEX_BINARY) {
		// HEX header (ARIB 3.10.1.2): C bit 12, F bits 13-14, N bits 15-20.
		complete = ((h >> 12) & 1) === 0 && ((h >> 13) & 3) === 3;
		msgNum = (h >> 15) & 0x3f;
	} else {
		// Alpha/secure/numeric header: C bit 10, F bits 11-12 (3=first/only), N bits 13-18.
		complete = ((h >> 10) & 1) === 0 && ((h >> 11) & 3) === 3;
		msgNum = (h >> 13) & 0x3f;
	}
	if (!complete) return plain;

	return dedupMessage(store, words, status, hdrIdx, bodyStart, bodyLen, vecType, msgNum, capcode, frameAbs);
}
