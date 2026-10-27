import { describe, expect, it } from 'vitest';
import { _POCSAGSingleBaud } from '@/worker/decoders/pocsag';
import { FskBitSlicer } from '@/worker/decoders/fsk-frontend';

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
			const signal = buildSignal(batch, { baud, amp: 0.025, dc: 0.05, preambleBits: 64 });
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

/*
 * Batch-boundary re-lock alignment.
 *
 * After a batch ends the decoder searches bit-by-bit for the next frame sync
 * codeword (FSC) and must re-lock at the EXACT 32-bit boundary. If the FSC
 * search accepts a near-sync window one bit early (e.g. on bare Hamming
 * distance without BCH-validating that the window corrects to exactly the sync
 * word), the entire following batch is shifted by one bit: every codeword
 * becomes a bit-shifted neighbour of the true word, which BCH then force-
 * "corrects" into phantom codewords. On a live off-air capture this showed as
 * an IDLE word (0x7a89c197) shifting into a bogus "message" 0xf513832e that
 * BCH corrected to a phantom — the trailing check/parity bits read wrong while
 * the data bits were a one-bit shift of IDLE.
 *
 * This drives TWO consecutive batches through the full slicer/PLL/framing
 * audio path. The second batch forces a between-batch FSC re-lock; a one-bit
 * misalignment corrupts its codewords. The payload must survive both batches.
 */
describe('POCSAG decoder — batch-boundary FSC re-lock alignment', () => {
	/**
	 * Build audio for consecutive batches, each preceded by its own 32-bit FSC
	 * (as a real multi-batch transmission sends), with ONE preamble before the
	 * first batch only. A clean, integer-spb square wave so any bit error is a
	 * framing fault, not noise.
	 */
	function buildMultiBatchSignal(batches, { rate = 48000, baud = 512, amp = 0.3, syncErrors = [] } = {}) {
		const spb = Math.round(rate / baud);
		const bits = [];
		for (let i = 0; i < 64; i++) bits.push(i & 1 ? 0 : 1); // preamble (first batch only)
		batches.forEach((batch, bi) => {
			// Optionally damage this batch's FSC by flipping the given bit
			// positions, as live RF does — this is what lets the bit-by-bit FSC
			// search reach its Hamming tolerance at a SHIFTED offset and re-lock
			// one bit early, shifting the whole batch.
			let fsc = _POCSAGSingleBaud.SYNC_WORD >>> 0;
			for (const b of syncErrors[bi] ?? []) fsc = (fsc ^ (1 << b)) >>> 0;
			for (const b of cwBits(fsc)) bits.push(b);
			for (const cw of batch) for (const b of cwBits(cw)) bits.push(b);
		});
		for (let i = 0; i < 64; i++) bits.push(i & 1 ? 0 : 1); // trailing dwell
		const out = new Float32Array(bits.length * spb);
		let k = 0;
		for (const bit of bits) {
			const level = bit ? -amp : amp;
			for (let s = 0; s < spb; s++) out[k++] = level;
		}
		return out;
	}

	it('re-locks at the exact boundary so a second batch decodes without a bit-shift', () => {
		for (const baud of [512, 1200]) {
			const msgs = [];
			const dec = new _POCSAGSingleBaud(48000, baud, (m) => msgs.push(m));
			// Batch 1 carries "FIRST", batch 2 carries "SECOND". Batch 2 can only
			// decode correctly if the between-batch FSC re-lock is bit-exact.
			const batch1 = buildBatch(0, alphaCodewords('FIRST'));
			const batch2 = buildBatch(0, alphaCodewords('SECOND'));
			const signal = buildMultiBatchSignal([batch1, batch2], { baud, amp: 0.3 });
			dec.process(signal);
			const texts = msgs.map((m) => m.text).join(' | ');
			expect(msgs.length, `baud ${baud}: got [${texts}]`).toBeGreaterThanOrEqual(2);
			expect(texts, `baud ${baud}`).toContain('FIRST');
			expect(texts, `baud ${baud}`).toContain('SECOND');
		}
	});

	it('re-locks exactly even when the between-batch FSC has a 1-bit error', () => {
		// A 1-bit-damaged second FSC is BCH-correctable to the sync word, so the
		// decoder must still re-lock — and at the CORRECT boundary. A bare-
		// Hamming search can match the damaged window one bit early (a shifted
		// offset also within Hamming tolerance), shifting batch 2. Validating
		// that the window BCH-corrects to EXACTLY the sync word (osmocom's rule)
		// pins the re-lock to the true boundary.
		const msgs = [];
		const dec = new _POCSAGSingleBaud(48000, 512, (m) => msgs.push(m));
		const batch1 = buildBatch(0, alphaCodewords('FIRST'));
		const batch2 = buildBatch(0, alphaCodewords('SECOND'));
		// Flip one bit in batch 2's FSC (bit 5, an arbitrary data-region bit).
		const signal = buildMultiBatchSignal([batch1, batch2], {
			baud: 512,
			amp: 0.3,
			syncErrors: [[], [5]],
		});
		dec.process(signal);
		const texts = msgs.map((m) => m.text).join(' | ');
		expect(texts).toContain('FIRST');
		expect(texts).toContain('SECOND');
	});

	it('does not manufacture phantom messages from a shifted IDLE batch', () => {
		// Two all-IDLE batches: the only legitimate output is nothing (IDLE
		// carries no page). A one-bit re-lock slip turns shifted IDLEs into
		// BCH-corrected phantom "messages" — so any emitted message is the bug.
		const msgs = [];
		const dec = new _POCSAGSingleBaud(48000, 512, (m) => msgs.push(m));
		const idleBatch = new Array(16).fill(_POCSAGSingleBaud.IDLE_CW);
		const signal = buildMultiBatchSignal([idleBatch, idleBatch], { baud: 512, amp: 0.3 });
		dec.process(signal);
		expect(msgs.length, `phantom messages: ${JSON.stringify(msgs.map((m) => m.text))}`).toBe(0);
	});
});

/*
 * Bit-recovery timing integrity (the FskBitSlicer PLL).
 *
 * These are the tests the earlier suite lacked: they drive the slicer at the
 * REAL, non-integer samples-per-bit the hardware produces (48000/512 = 93.75)
 * using a CONTINUOUS bit clock (sample n belongs to bit floor(n/spb)), not a
 * rounded integer grid. A correct PLL emits exactly one bit per symbol period
 * over a long run; a PLL that drifts drops or duplicates a bit, which on the
 * real decoder slid a whole batch by one bit and manufactured phantom
 * codewords. The earlier tests used integer spb and never exercised this.
 */
describe('FskBitSlicer — fractional-spb timing integrity', () => {
	/** Render a bit list at a continuous (possibly fractional) bit clock. */
	function renderContinuous(bits, rate, baud, amp = 0.3) {
		const spb = rate / baud;
		const n = Math.floor(bits.length * spb);
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = bits[Math.floor(i / spb)] ? -amp : amp;
		return out;
	}

	/** Count bits the locked slicer emits for a rendered signal. */
	function emittedBits(sig, rate, baud) {
		let count = 0;
		const dec = new FskBitSlicer(rate, baud, () => count++);
		dec.pllLocked = true;
		dec.process(sig);
		return count;
	}

	// A correct PLL has ZERO CUMULATIVE drift: the emitted-vs-input bit-count
	// error is a fixed edge artifact (acquisition settle + trailing partial
	// symbol) that does NOT grow with stream length. We assert that by taking
	// the SAME measurement at two very different lengths and requiring the error
	// to be identical — any growth is real timing drift that slides batches.
	it.each([512, 1200, 2400])('has no length-dependent timing drift at %i Bd', (baud) => {
		const mk = (nbits) => {
			const bits = [];
			for (let i = 0; i < nbits; i++) bits.push(i & 1);
			return emittedBits(renderContinuous(bits, 48000, baud), 48000, baud) - nbits;
		};
		const short = mk(4000);
		const long = mk(40000);
		expect(long, `baud ${baud}: drift grew ${short} -> ${long} over 10x length`).toBe(short);
	});
});
