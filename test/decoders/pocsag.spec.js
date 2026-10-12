import { describe, expect, it } from 'vitest';
import { _POCSAGSingleBaud } from '@/worker/decoders/pocsag';

/*
 * Synthetic-batch tests for the POCSAG decoder.
 *
 * Valid batches are generated directly through the decoder's bit interface,
 * computing BCH + even parity via the decoder's OWN ecc (a codeword is valid
 * iff _eccCorrect reports 0 errors), so the frames are guaranteed decodable
 * without any external capture files.
 */

/** Build a valid 32-bit codeword: 21-bit payload (type bit + 20 data) + BCH + even parity. */
function buildCodeword(payload21) {
	const dec = new _POCSAGSingleBaud(48000, 1200, () => {});
	// Place the 21-bit payload at bits 31..11, brute-force the 10 BCH bits
	// (bits 10..1) by asking the decoder's own ECC for a zero-error result.
	const base = (payload21 >>> 0) << 11;
	for (let ecc = 0; ecc < 1024; ecc++) {
		let cw = (base | (ecc << 1)) >>> 0;
		// Set even parity over the full 32 bits, then ask the decoder's own ECC
		// to confirm the word is valid. The decoder's correction is parity-aware,
		// so a valid codeword must satisfy BCH AND parity.
		if (dec._popcount32(cw) & 1) cw = (cw | 1) >>> 0;
		const r = dec._eccCorrect(cw);
		if (r.errors === 0 && r.cw === cw) {
			return cw >>> 0;
		}
	}
	throw new Error('no valid BCH codeword found for payload');
}

/** Drive a list of 32-bit codewords through a sub-decoder as one batch. */
function decodeBatch(func, bodyCodewords) {
	const msgs = [];
	const dec = new _POCSAGSingleBaud(48000, 1200, (m) => msgs.push(m));
	// Address codeword: type bit 0, func in bits 12..11 of payload, placed at
	// frame slot 0 (cwIdx 0). payload21 layout: [type:1][addrHigh:18][func:2].
	const addrPayload = ((0 << 20) | (0x155 << 2) | (func & 3)) >>> 0;
	const addrCw = buildCodeword(addrPayload);
	// Feed sync, then address at cwIdx 0, then body, then IDLE to flush.
	dec._onSync();
	dec._onCodeword(addrCw);
	for (const cw of bodyCodewords) dec._onCodeword(cw);
	dec._onCodeword(_POCSAGSingleBaud.IDLE_CW);
	return msgs;
}

/** Encode an alpha string into message codewords (7-bit LSB-first, type bit 1). */
function alphaCodewords(text) {
	const bits = [];
	for (const ch of text) {
		const c = ch.charCodeAt(0) & 0x7f;
		for (let b = 0; b < 7; b++) bits.push((c >> b) & 1);
	}
	while (bits.length % 20) bits.push(0);
	const cws = [];
	for (let i = 0; i < bits.length; i += 20) {
		let data = 0;
		for (let b = 0; b < 20; b++) data = (data << 1) | bits[i + b];
		cws.push(buildCodeword(((1 << 20) | data) >>> 0));
	}
	return cws;
}

/** Encode a numeric string into message codewords (4-bit LSB-first, type bit 1). */
function numericCodewords(digits) {
	const NMAP = '0123456789RU -][';
	const bits = [];
	for (const ch of digits) {
		const n = NMAP.indexOf(ch);
		for (let b = 0; b < 4; b++) bits.push((n >> b) & 1);
	}
	while (bits.length % 20) bits.push(0);
	const cws = [];
	for (let i = 0; i < bits.length; i += 20) {
		let data = 0;
		for (let b = 0; b < 20; b++) data = (data << 1) | bits[i + b];
		cws.push(buildCodeword(((1 << 20) | data) >>> 0));
	}
	return cws;
}

/*
 * Content-based message-type detection.
 *
 * The POCSAG function field is a sub-address, NOT a reliable encoding
 * indicator (ITU-R M.584). The decoder must pick the encoding by scoring the
 * decoded content, so an alphanumeric page on func 0/1 is read as text and a
 * numeric page on func 0 is read as digits — regardless of the function bits.
 */
describe('POCSAG decoder — content-based type detection', () => {
	it('reads an alphanumeric page sent on func 0 as text (not tone/numeric)', () => {
		const msgs = decodeBatch(0, alphaCodewords('HELLO'));
		expect(msgs.length).toBeGreaterThan(0);
		const m = msgs[0];
		expect(m.func).toBe(0); // func is preserved as metadata
		expect(m.type).toBe('alpha'); // but type is chosen by content
		expect(m.text).toContain('HELLO');
	});

	it('reads an alphanumeric page sent on func 1 as text', () => {
		const msgs = decodeBatch(1, alphaCodewords('PAGE'));
		expect(msgs.length).toBeGreaterThan(0);
		expect(msgs[0].type).toBe('alpha');
		expect(msgs[0].text).toContain('PAGE');
	});

	it('reads a numeric page sent on func 0 as digits (not dropped as tone)', () => {
		const msgs = decodeBatch(0, numericCodewords('0123456789'));
		expect(msgs.length).toBeGreaterThan(0);
		const m = msgs[0];
		expect(m.type).toBe('numeric');
		expect(m.text).toContain('0123456789');
	});
});

/*
 * Codepage selection. The same 7-bit codes map to different glyphs depending
 * on the selected pager codepage. We drive synthetic alpha batches through the
 * sub-decoder with a chosen charset and assert the vendor/national glyphs.
 */
import { pocsagCodepage, POCSAG_CHARSETS } from '@/worker/decoders/charsets';

/** Decode a synthetic alpha batch under a given charset key. */
function decodeAlphaWithCharset(text, charset) {
	const msgs = [];
	const dec = new _POCSAGSingleBaud(48000, 1200, (m) => msgs.push(m), charset);
	const addrPayload = ((0 << 20) | (0x155 << 2) | 3) >>> 0;
	dec._onSync();
	dec._onCodeword(buildCodeword(addrPayload));
	for (const cw of alphaCodewords(text)) dec._onCodeword(cw);
	dec._onCodeword(_POCSAGSingleBaud.IDLE_CW);
	return msgs[0];
}

describe('POCSAG decoder — codepage selection', () => {
	it('registers 26 identities over 19 unique tables', () => {
		expect(POCSAG_CHARSETS).toHaveLength(26);
		const tableIds = new Set(POCSAG_CHARSETS.map((e) => e.tableId));
		expect(tableIds.size).toBe(19);
	});

	it('German codepage maps [ \\ ] { | } ~ to umlauts', () => {
		const cp = pocsagCodepage({ vendor: 'generic', model: 'generic', codepage: 'latin-german' });
		expect(cp[0x5b]).toBe('Ä');
		expect(cp[0x5c]).toBe('Ö');
		expect(cp[0x5d]).toBe('Ü');
		expect(cp[0x7b]).toBe('ä');
		expect(cp[0x7e]).toBe('ß');
		expect(cp[0x40]).toBe('§');
	});

	it('ASCII codepage keeps [ \\ ] as brackets', () => {
		const cp = pocsagCodepage({ vendor: 'generic', model: 'generic', codepage: 'ascii' });
		expect(cp[0x5b]).toBe('[');
		expect(cp[0x7e]).toBe('~');
	});

	it('unknown charset key falls back to ASCII', () => {
		const cp = pocsagCodepage({ vendor: 'nope', model: 'nope', codepage: 'nope' });
		expect(cp[0x41]).toBe('A');
		expect(cp[0x5b]).toBe('[');
	});

	it('decodes the same bytes to German glyphs under the German codepage', () => {
		// A letter-heavy string so content-scoring picks alpha; the chars [ \\ ]
		// (codes 0x5B 0x5C 0x5D) render as Ä Ö Ü under the German codepage and
		// stay brackets under ASCII.
		const text = 'STRASSE[\\]ENDE';
		const ascii = decodeAlphaWithCharset(text, { vendor: 'generic', model: 'generic', codepage: 'ascii' });
		const german = decodeAlphaWithCharset(text, { vendor: 'generic', model: 'generic', codepage: 'latin-german' });
		expect(ascii.text).toContain('[');
		expect(ascii.text).toContain('STRASSE');
		expect(german.text).toContain('Ä');
		expect(german.text).toContain('Ö');
		expect(german.text).toContain('Ü');
		expect(german.text).toContain('STRASSE');
	});
});

/*
 * Regression tests for the PR #49 review (jLynx), each pinned to a reviewer
 * finding so a future change that reintroduces the regression fails here.
 *
 * These drive either the decoder's codeword interface (buildCodeword +
 * _onSync/_onCodeword) or a synthesized audio stream (buildSignal), so no
 * external capture files are needed.
 */

/** 32-bit codeword MSB-first → bits, then as a flat bit array (sync + body). */
function cwBits(cw) {
	const bits = [];
	for (let b = 31; b >= 0; b--) bits.push((cw >>> b) & 1);
	return bits;
}

/**
 * Synthesize FM-demod audio for a list of 32-bit codewords at `baud`, preceded
 * by `preambleBits` of alternating 1010… and the frame sync word. The decoder's
 * convention is mark ("1") = negative deviation, so a 1 bit → amplitude −amp.
 * A constant `dc` offset is added to the whole signal. Returns a Float32Array
 * at `rate` Hz (integer samples-per-bit).
 */
function buildSignal(codewords, { rate = 48000, baud = 1200, preambleBits = 64, amp = 0.025, dc = 0 } = {}) {
	const spb = Math.round(rate / baud);
	const bits = [];
	for (let i = 0; i < preambleBits; i++) bits.push(i & 1 ? 0 : 1); // 1010…
	for (const b of cwBits(_POCSAGSingleBaud.SYNC_WORD)) bits.push(b);
	for (const cw of codewords) for (const b of cwBits(cw)) bits.push(b);
	// Trailing dwell so the final batch's codewords are fully clocked out.
	for (let i = 0; i < 64; i++) bits.push(i & 1 ? 0 : 1);
	const out = new Float32Array(bits.length * spb);
	let k = 0;
	for (const bit of bits) {
		const level = (bit ? -amp : amp) + dc;
		for (let s = 0; s < spb; s++) out[k++] = level;
	}
	return out;
}

/** Build a full 16-codeword batch: address at slot 0, body, IDLE padding. */
function buildBatch(func, body) {
	const addrPayload = ((0 << 20) | (0x155 << 2) | (func & 3)) >>> 0;
	const cws = [buildCodeword(addrPayload), ...body];
	while (cws.length < 16) cws.push(_POCSAGSingleBaud.IDLE_CW);
	return cws.slice(0, 16);
}

describe('POCSAG decoder — PR #49 review regressions', () => {
	// Item 4: the DC estimator must converge to a steady offset during
	// acquisition. The old crawl-to-zero on every unlocked sample prevented it
	// from cancelling the offset, so a DC-offset page never acquired.
	it('acquires a page carrying a steady DC offset (DC estimator converges)', () => {
		for (const baud of [512, 1200]) {
			const msgs = [];
			const dec = new _POCSAGSingleBaud(48000, baud, (m) => msgs.push(m));
			const batch = buildBatch(0, alphaCodewords('DCTEST'));
			const signal = buildSignal(batch, { baud, amp: 0.025, dc: 0.05 });
			dec.process(signal);
			expect(msgs.length, `baud ${baud}`).toBeGreaterThan(0);
			expect(msgs[0].text).toContain('DCTEST');
		}
	});

	// Item 5: joining an ongoing transmission. A batch whose sync has a 1-bit
	// error and which is NOT preceded by a preamble (mid-stream) must still
	// acquire — the old gate required a preamble before any corrected sync.
	it('acquires on a 1-bit-damaged sync with no preceding preamble (late join)', () => {
		const msgs = [];
		const dec = new _POCSAGSingleBaud(48000, 1200, (m) => msgs.push(m));
		const batch = buildBatch(0, alphaCodewords('LATE'));
		const damagedSync = (_POCSAGSingleBaud.SYNC_WORD ^ 0x1) >>> 0;
		// No preamble: a damaged sync immediately, as when tuning into a live tx.
		const bits = [];
		for (const b of cwBits(damagedSync)) bits.push(b);
		for (const cw of batch) for (const b of cwBits(cw)) bits.push(b);
		for (let i = 0; i < 64; i++) bits.push(i & 1 ? 0 : 1);
		const spb = 40; // 48000 / 1200
		const audio = new Float32Array(bits.length * spb);
		let k = 0;
		for (const bit of bits) {
			const level = bit ? -0.025 : 0.025;
			for (let s = 0; s < spb; s++) audio[k++] = level;
		}
		dec.process(audio);
		expect(msgs.length).toBeGreaterThan(0);
		expect(msgs[0].text).toContain('LATE');
	});

	// Item 5 (false-lock guard retained): a provisional lock whose first
	// codeword is uncorrectable garbage must be dropped without emitting.
	it('does not false-lock on a provisional sync followed by noise', () => {
		const msgs = [];
		const dec = new _POCSAGSingleBaud(48000, 1200, (m) => msgs.push(m));
		let bad = 0;
		for (let w = 0x11111111; w < 0xffffffff; w += 0x11111113) {
			if (dec._eccCorrect(w >>> 0).errors >= 3) {
				bad = w >>> 0;
				break;
			}
		}
		dec._onSync(true); // provisional lock, as the hunt path would grant
		dec._onCodeword(bad); // uncorrectable → drop the lock
		dec._onCodeword(_POCSAGSingleBaud.IDLE_CW);
		expect(msgs.length).toBe(0);
		expect(dec.state).toBe('hunt');
	});

	// Item 6: the two-bad-codeword end-of-message policy must carry across a
	// batch boundary. An uncorrectable last word of batch N followed by an
	// uncorrectable first word of batch N+1 must terminate the message.
	it('preserves the uncorrectable-run count across a batch sync', () => {
		const msgs = [];
		const dec = new _POCSAGSingleBaud(48000, 1200, (m) => msgs.push(m));
		// Two codewords the decoder's OWN ecc confirms are uncorrectable
		// (≥3 bit errors from any valid word) — not guessed constants.
		const bad = [];
		for (let w = 0x11111111; bad.length < 2 && w < 0xffffffff; w += 0x11111113) {
			if (dec._eccCorrect(w >>> 0).errors >= 3) bad.push(w >>> 0);
		}
		expect(bad.length).toBe(2);
		dec._onSync();
		// Open a page with some clean content.
		const addrPayload = ((0 << 20) | (0x155 << 2) | 0) >>> 0;
		dec._onCodeword(buildCodeword(addrPayload));
		for (const cw of alphaCodewords('AB')) dec._onCodeword(cw);
		// One uncorrectable word as the (effective) last of the batch.
		dec._onCodeword(bad[0]);
		expect(dec.consecBad).toBe(1);
		expect(dec.pageActive).toBe(true);
		// Batch boundary resync (page still open) must NOT reset consecBad.
		dec._onSync();
		expect(dec.consecBad).toBe(1);
		// Second uncorrectable word, now first of the new batch → terminate.
		dec._onCodeword(bad[1]);
		expect(dec.pageActive).toBe(false);
		expect(msgs.length).toBeGreaterThan(0);
	});

	// Item 7 + steering: alpha is PREFERRED on an ambiguous page. Independently
	// encoded alpha pages that also read as pure digits must come back as alpha.
	it.each(['A', 'AB', '12345'])('reads an alpha-encoded %s as alpha, not numeric', (text) => {
		const msgs = decodeBatch(0, alphaCodewords(text));
		expect(msgs.length).toBeGreaterThan(0);
		expect(msgs[0].type).toBe('alpha');
		expect(msgs[0].text).toContain(text);
	});

	// Item 7: a genuinely ambiguous page exposes the numeric alternate so the
	// reading is not silently hidden behind the alpha pick.
	it('exposes the numeric alternate on an ambiguous page', () => {
		const msgs = decodeBatch(0, alphaCodewords('12345'));
		expect(msgs[0].type).toBe('alpha');
		expect(msgs[0].alt).toBeDefined();
		expect(msgs[0].alt.type).toBe('numeric');
	});

	// Item 7 (no regression): a real numeric page is still numeric.
	it('still reads a numeric-encoded page as numeric', () => {
		const msgs = decodeBatch(0, numericCodewords('0123456789'));
		expect(msgs[0].type).toBe('numeric');
		expect(msgs[0].text).toContain('0123456789');
	});
});
