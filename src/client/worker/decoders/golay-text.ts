/**
 * GSC message text codec: the Rep. 900-2 alpha (Table VI) and numeric
 * (Table VII) character tables, per-symbol decode, output rendering, the
 * block-to-text builders (which carry per-character source-block indices for
 * FEC colour-coding), and the alpha/numeric discriminate scoring (a port of
 * osmocom golay.c gsc_score_alpha / gsc_score_numeric). Extracted from golay.ts
 * to keep the decoder state machine under the file-size limit.
 */

// Rep. 900-2 Table VI — 6-bit alpha. 0x3C=CR, 0x3E=NUL fill, 0x3F='_'. Uppercase.
// prettier-ignore
const ALPHA_DECODE: string[] = [
	' ', '!', '"', '#', '$', '%', '&', "'",
	'(', ')', '*', '+', ',', '-', '.', '/',
	'0', '1', '2', '3', '4', '5', '6', '7',
	'8', '9', ':', ';', '<', '=', '>', '?',
	'\\', 'A', 'B', 'C', 'D', 'E', 'F', 'G',
	'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
	'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W',
	'X', 'Y', 'Z', '{', '\r', '}', '\0', '_',
];

// Rep. 900-2 Table VII — 4-bit numeric. '\0' = fill / shift / EOM.
// prettier-ignore
const NUMERIC_DECODE: string[] = [
	'0', '1', '2', '3', '4', '5', '6', '7',
	'8', '9', '\0', 'U', ' ', '-', '\0', '\0',
];
// prettier-ignore
const NUMERIC_SHIFT: string[] = [
	'A', 'B', 'C', 'D', 'E', ' ', 'F', 'G',
	'H', 'J', '\0', 'L', 'N', 'P', 'R', '?',
];

export const ALPHA_FILL = 0x3e;
export const NUMERIC_FILL = 0x0a;

/** Decode one 4-bit numeric nibble, honouring the shift prefix (0x0F). */
export function decodeNumeric(code: number, state: { shifted: boolean }): string {
	const c = code & 0x0f;
	if (state.shifted) {
		state.shifted = false;
		return NUMERIC_SHIFT[c];
	}
	if (c === 0x0f) {
		state.shifted = true;
		return '\0';
	}
	return NUMERIC_DECODE[c];
}

/** Render a decoded char for output: printable ASCII as-is, else <0xNN>. */
function renderChar(c: string): string {
	const code = c.charCodeAt(0);
	if (code >= 0x20 && code <= 0x7e) return c;
	return `<0x${code.toString(16).padStart(2, '0').toUpperCase()}>`;
}

/** Build the alpha string from 6-bit codes, carrying each output char's source
 * block index (parallel to the text) for per-codeword FEC colouring. */
export function buildAlpha(codes: number[], blk: number[]): { text: string; blk: number[] } {
	let out = '';
	const outBlk: number[] = [];
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i];
		if (code === ALPHA_FILL) continue; // NUL fill
		const c = ALPHA_DECODE[code & 0x3f];
		if (c === '\0') continue;
		const rendered = renderChar(c);
		out += rendered;
		for (let j = 0; j < rendered.length; j++) outBlk.push(blk[i]);
	}
	return { text: out, blk: outBlk };
}

/** Build the numeric string from 4-bit nibbles, carrying source block indices. */
export function buildNumeric(nibbles: number[], blk: number[]): { text: string; blk: number[] } {
	let out = '';
	const outBlk: number[] = [];
	const st = { shifted: false };
	for (let i = 0; i < nibbles.length; i++) {
		const nib = nibbles[i];
		if (nib === NUMERIC_FILL) continue; // fill
		const c = decodeNumeric(nib, st);
		if (c === '\0') continue;
		const rendered = renderChar(c);
		out += rendered;
		for (let j = 0; j < rendered.length; j++) outBlk.push(blk[i]);
	}
	return { text: out, blk: outBlk };
}

/** Score an alpha interpretation (adapted from osmocom gsc_score_alpha): +4 per
 * letter A-Z, +3 digit/space, -2 other printable, -5 non-char, plus a 2*fill^2
 * bonus; fill slots (0x3E) score only via the bonus. Letters weigh slightly
 * more than digits because a letter is unambiguous text evidence while a digit
 * is ambiguous (either type) - this makes a full 8-letter block (no trailing
 * fill) win over its coincidental all-digit numeric reinterpretation. */
export function scoreAlpha(codes: number[], fill: number): number {
	let score = 0;
	for (const code of codes) {
		const c6 = code & 0x3f;
		if (c6 === ALPHA_FILL) continue;
		const c = ALPHA_DECODE[c6];
		if (c === '\0') {
			score -= 5;
		} else if (c >= 'A' && c <= 'Z') {
			score += 4;
		} else if ((c >= '0' && c <= '9') || c === ' ') {
			score += 3;
		} else {
			const cc = c.charCodeAt(0);
			score += cc >= 0x20 && cc <= 0x7e ? -2 : -5;
		}
	}
	return score + fill * fill * 2;
}

/** Score a numeric interpretation (osmocom gsc_score_numeric): +3 per digit,
 * -1 leading 'U' (urgent prefix) else -15 stray 'U', -2 space/hyphen/EOM/shift,
 * plus a fill^2 bonus. Fill nibbles (0x0A) are scored only via the bonus. */
export function scoreNumeric(nibbles: number[], fill: number): number {
	let score = 0;
	let uCount = 0;
	let firstU = -1;
	for (let i = 0; i < nibbles.length; i++) {
		const n = nibbles[i];
		if (n === NUMERIC_FILL) continue;
		if (n === 0x0b) {
			uCount++;
			if (firstU < 0) firstU = i;
		}
	}
	const urgentPrefix = uCount === 1 && firstU === 0;
	for (const n of nibbles) {
		if (n === NUMERIC_FILL) continue;
		if (n <= 0x09) score += 3;
		else if (n === 0x0b) score += urgentPrefix ? -1 : -15;
		else if (n >= 0x0c && n <= 0x0e) score -= 2;
		else if (n === 0x0f) score -= 2;
	}
	return score + fill * fill;
}
