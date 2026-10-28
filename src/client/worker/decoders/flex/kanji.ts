/**
 * FLEX Kanji / Shift-JIS alpha payload extraction. Split out of frame.ts.
 * One 16-bit character per word (bits 0-15); the signature word is skipped on
 * an initial fragment and NUL padding is skipped. The 16-bit values are
 * Shift-JIS codes (not Unicode), collected big-endian and transcoded via
 * TextDecoder('shift-jis'); a lost word flushes the current run and inserts
 * U+FFFD. Mirrors the osmocom kanji branch.
 */

const FLEX_WORDS_PER_FRAME = 88;
const WORD_NOT_RECEIVED = 0;
const WORD_UNCORRECTABLE = 3;

function wordLost(status: number): boolean {
	return status === WORD_UNCORRECTABLE || status === WORD_NOT_RECEIVED;
}

/** Extract Shift-JIS text from words[startWord..mw2]. `wordsOk` is false when
 * any word was lost (mirrors osmocom frag_words_ok). */
export function extractKanji(
	words: Uint32Array,
	status: Int8Array,
	startWord: number,
	mw2: number,
	isInitial: boolean,
): { text: string; wordsOk: boolean } {
	const sjis = new TextDecoder('shift-jis');
	let text = '';
	let bytes: number[] = [];
	let wordsOk = true;
	const flush = () => {
		if (bytes.length) {
			text += sjis.decode(new Uint8Array(bytes));
			bytes = [];
		}
	};
	for (let w = startWord; w <= mw2 && w < FLEX_WORDS_PER_FRAME; w++) {
		if (wordLost(status[w])) {
			wordsOk = false;
			if (!(w === startWord && isInitial)) {
				flush();
				text += '\uFFFD';
			}
			continue;
		}
		if (w === startWord && isInitial) continue; // signature word, no 16-bit char
		const ch16 = words[w] & 0xffff;
		if (ch16 === 0) continue; // NUL padding
		bytes.push((ch16 >> 8) & 0xff, ch16 & 0xff);
	}
	flush();
	return { text, wordsOk };
}
