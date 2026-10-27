/**
 * FLEX multi-transmission subframe combine (ARIB STD-43A 3.4.2).
 *
 * When a frame is transmitted multiple times (numTx = 2/3/4), it carries that
 * many copies of a shorter subframe. This best-of combine merges the copies
 * word-by-word into one subframe, preferring the highest-confidence word.
 * A faithful port of osmocom flex_rx_subframe_combine.
 */

const FLEX_WORDS_PER_FRAME = 88;
// Word status values shared with the frame decoder (frame.h flex_word_status).
const WORD_NOT_RECEIVED = 0;
const WORD_CLEAN = 1;
const WORD_CORRECTED = 2;
const WORD_UNCORRECTABLE = 3;

/** Per-transmission subframe word count (frame.h FLEX_SUBFRAME_WORDS_*). */
function subframeWords(numTransmissions: number): number {
	switch (numTransmissions) {
		case 2:
			return 44;
		case 3:
			return 29;
		case 4:
			return 22;
		default:
			return FLEX_WORDS_PER_FRAME;
	}
}

/**
 * Combine the numTx (>1) in-frame subframe copies into one best-of subframe:
 * CLEAN beats CORRECTED beats UNCORRECTABLE, and among CORRECTED the copy with
 * fewer uncorrectable words wins. Returns combined words+status sized to the
 * subframe; words beyond it are NOT_RECEIVED. numTx <= 1 passes through.
 */
export function combineSubframes(words: Uint32Array, status: Int8Array, numTx: number): { words: Uint32Array; status: Int8Array } {
	const sfWords = subframeWords(numTx);
	if (numTx <= 1) return { words, status };

	// Per-copy uncorrectable totals, for the CORRECTED tie-break.
	const ucCount = new Array<number>(numTx).fill(0);
	for (let sf = 0; sf < numTx; sf++) {
		const off = sf * sfWords;
		for (let i = 0; i < sfWords && off + i < FLEX_WORDS_PER_FRAME; i++) {
			if (status[off + i] === WORD_UNCORRECTABLE || status[off + i] === WORD_NOT_RECEIVED) ucCount[sf]++;
		}
	}

	const outWords = new Uint32Array(FLEX_WORDS_PER_FRAME);
	const outStatus = new Int8Array(FLEX_WORDS_PER_FRAME);
	for (let i = 0; i < sfWords; i++) {
		let bestStatus = WORD_UNCORRECTABLE;
		let bestWord = 0;
		let bestUc = sfWords + 1;
		let haveWord = false; // at least one copy contributed a word
		for (let sf = 0; sf < numTx; sf++) {
			const off = sf * sfWords;
			if (off + i >= FLEX_WORDS_PER_FRAME) continue;
			const s = status[off + i];
			if (s === WORD_CLEAN) {
				bestStatus = WORD_CLEAN;
				bestWord = words[off + i];
				break;
			}
			if (s === WORD_CORRECTED && (bestStatus !== WORD_CORRECTED || ucCount[sf] < bestUc)) {
				bestStatus = WORD_CORRECTED;
				bestWord = words[off + i];
				bestUc = ucCount[sf];
				haveWord = true;
			} else if (!haveWord) {
				// First copy seen for this word (so far only uncorrectable).
				bestWord = words[off + i];
				bestUc = ucCount[sf];
				haveWord = true;
			}
		}
		outWords[i] = bestWord;
		outStatus[i] = bestStatus;
	}
	return { words: outWords, status: outStatus };
}
