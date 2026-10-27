import { describe, it, expect } from 'vitest';
import { decodeBatch, decodeGolay, decodeBch, initFec, GSCDecoder } from '@/worker/decoders/golay';
import { scoreAlpha, scoreNumeric } from '@/worker/decoders/golay-text';

// ── Synthetic GSC encoder (mirrors osmocom-analog golay.c queue_batch layout)
// so we can prove decodeBatch end-to-end without a real capture. Only the
// pieces decodeBatch consumes are produced: start code, address W1/W2, and
// one alpha data block.

const GEN_GOL = 0x00000c75;
const GEN_BCH = 0x00000117;
const START_CODE = 713;
const WORD1S = [
	721, 2731, 2952, 1387, 1578, 1708, 2650, 1747, 2580, 1376, 2692, 696, 1667, 3800, 3552, 3424, 1384, 3595, 876, 3124, 2285, 2608, 899,
	3684, 3129, 2124, 1287, 2616, 1647, 3216, 375, 1232, 2824, 1840, 408, 3127, 3387, 882, 3468, 3267, 1575, 3463, 3152, 2572, 1252, 2592,
	1552, 835, 1440, 160,
];

/** Golay(23,12) systematic encode. */
function encGolay(data) {
	let syndrome = (data & 0xfff) << 11;
	let aux = 0x00400000;
	if (syndrome >= 0x800) {
		while (syndrome & 0xfffff800) {
			while (!(aux & syndrome)) aux = aux >>> 1;
			syndrome = (syndrome ^ (Math.floor(aux / 0x800) * GEN_GOL)) >>> 0;
		}
	}
	return ((data & 0xfff) | (syndrome << 12)) >>> 0;
}

/** BCH(15,7) systematic encode. */
function encBch(data) {
	let syndrome = (data & 0x7f) << 8;
	let aux = 0x4000;
	if (syndrome >= 0x100) {
		while (syndrome & 0xff00) {
			while (!(aux & syndrome)) aux = aux >>> 1;
			syndrome = (syndrome ^ (Math.floor(aux / 0x100) * GEN_BCH)) & 0xffff;
		}
	}
	return ((data & 0x7f) | (syndrome << 7)) & 0xffff;
}

class Enc {
	constructor() {
		this.bits = [];
	}
	bit(b) {
		this.bits.push(b & 1);
	}
	comma(len, startBit) {
		for (let i = 0; i < len; i++) this.bit((startBit + i) & 1);
	}
	dup(cw, n) {
		for (let i = 0; i < n; i++) {
			this.bit((cw >> i) & 1);
			this.bit((cw >> i) & 1);
		}
	}
}

/** Encode uppercase ASCII subset into 6-bit Table VII codes. */
function alphaCodes(msg) {
	const codes = [];
	for (const ch of msg.toUpperCase()) codes.push((ch.charCodeAt(0) - 0x20) & 0x3f);
	return codes;
}

/** One alpha data block: pack 8 six-bit chars into 7 data bytes, checksum,
 * BCH-encode, interleave. Emits 1 comma bit + 120 block bits. contbit sets the
 * continuation flag (bit 6 of d[6]) so multiple blocks chain. */
function encodeAlphaBlock(enc, chars, contbit = 0) {
	const c = new Array(8).fill(0x3e); // 0x3E fill
	for (let i = 0; i < Math.min(8, chars.length); i++) c[i] = chars[i] & 0x3f;
	const d = new Array(8).fill(0);
	d[0] = (c[0] | (c[1] << 6)) & 0x7f;
	d[1] = ((c[1] >> 1) | (c[2] << 5)) & 0x7f;
	d[2] = ((c[2] >> 2) | (c[3] << 4)) & 0x7f;
	d[3] = ((c[3] >> 3) | (c[4] << 3)) & 0x7f;
	d[4] = ((c[4] >> 4) | (c[5] << 2)) & 0x7f;
	d[5] = ((c[5] >> 5) | (c[6] << 1)) & 0x7f;
	d[6] = (c[7] & 0x3f) | ((contbit & 1) << 6); // bits 0-5 char7, bit6 continuation
	let cksum = 0;
	for (let k = 0; k < 7; k++) cksum += encBch(d[k]); // sum full 15-bit codewords
	d[7] = cksum & 0x7f;
	const bch = d.map((x) => encBch(x));
	enc.bit(0); // 1-bit inverted comma
	for (let j = 0; j < 15; j++) for (let k = 0; k < 8; k++) enc.bit((bch[k] >> j) & 1);
}

/** Encode an alpha message of any length as chained 8-char blocks. */
function encodeAlphaMessage(enc, message) {
	const codes = alphaCodes(message);
	for (let off = 0; off < codes.length; off += 8) {
		const slice = codes.slice(off, off + 8);
		const more = off + 8 < codes.length ? 1 : 0;
		encodeAlphaBlock(enc, slice, more);
	}
}

function encodeBatch(word1Idx, w2, func, message, withPreamble = false) {
	const enc = new Enc();
	if (withPreamble) {
		// Preamble: 28-bit comma + 18 dup codewords of preamble_values[0],
		// matching the encoder; decode reports preamble index 0.
		const pg = encGolay(2030); // preamble_values[0]
		enc.comma(28, pg & 1);
		for (let i = 0; i < 18; i++) enc.dup(pg, 23);
	}
	// Start code.
	let g = encGolay(START_CODE);
	enc.comma(28, g & 1);
	enc.dup(g, 23);
	const gc = (g ^ 0x7fffff) >>> 0;
	enc.bit((gc & 1) ^ 1);
	enc.dup(gc, 23);
	// Address W1.
	g = encGolay(WORD1S[word1Idx]);
	if (func & 0x2) g = (g ^ 0x7fffff) >>> 0;
	enc.comma(28, g & 1);
	enc.dup(g, 23);
	// Address W2.
	g = encGolay(w2);
	if (func & 0x1) g = (g ^ 0x7fffff) >>> 0;
	enc.bit((g & 1) ^ 1);
	enc.dup(g, 23);
	// Alpha data block(s) — chained for messages longer than 8 chars.
	encodeAlphaMessage(enc, message);
	// Tail so decodeContent has room past the final block.
	for (let i = 0; i < 200; i++) enc.bit(i & 1);
	return enc.bits;
}

/** A voice page: preamble + start code + address, then a 28-bit comma followed
 * by the activation code (2563) as a dup-Golay codeword, which decodeContent
 * recognizes as type 'voice'. */
function encodeVoiceBatch(word1Idx, w2, func) {
	const enc = new Enc();
	const pg = encGolay(2030);
	enc.comma(28, pg & 1);
	for (let i = 0; i < 18; i++) enc.dup(pg, 23);
	let g = encGolay(START_CODE);
	enc.comma(28, g & 1);
	enc.dup(g, 23);
	const gc = (g ^ 0x7fffff) >>> 0;
	enc.bit((gc & 1) ^ 1);
	enc.dup(gc, 23);
	g = encGolay(WORD1S[word1Idx]);
	if (func & 0x2) g = (g ^ 0x7fffff) >>> 0;
	enc.comma(28, g & 1);
	enc.dup(g, 23);
	g = encGolay(w2);
	if (func & 0x1) g = (g ^ 0x7fffff) >>> 0;
	enc.bit((g & 1) ^ 1);
	enc.dup(g, 23);
	// Activation code after a 28-bit comma => voice.
	const av = encGolay(2563);
	enc.comma(28, av & 1);
	enc.dup(av, 23);
	for (let i = 0; i < 100; i++) enc.bit(i & 1);
	return enc.bits;
}

/** The activation (voice stop) sequence as the encoder sends it (golay.c Stage
 * 6): 46-bit dup-Golay of the activation code, 1 comma bit, then a 46-bit dup
 * of its 1's-complement. */
function appendActivationStop(enc) {
	const av = encGolay(2563);
	enc.dup(av, 23);
	const avc = (av ^ 0x7fffff) >>> 0;
	enc.bit((avc & 1) ^ 1);
	enc.dup(avc, 23);
}

describe('GSC/Golay FEC', () => {
	it('Golay(23,12) round-trips and corrects 3 bit errors', () => {
		initFec();
		for (const data of [0, 1, 713, 2563, 0xabc, 0xfff]) {
			const cw = encGolay(data);
			expect(decodeGolay(cw).data).toBe(data & 0xfff);
			const bad = (cw ^ 0b1011) >>> 0; // 3-bit error
			const r = decodeGolay(bad);
			expect(r).not.toBeNull();
			expect(r.data).toBe(data & 0xfff);
		}
	});

	it('BCH(15,7) round-trips and corrects 2 bit errors', () => {
		initFec();
		for (const data of [0, 1, 0x55, 0x7f]) {
			const cw = encBch(data);
			expect(decodeBch(cw).data).toBe(data & 0x7f);
			const bad = (cw ^ 0b101) & 0xffff; // 2-bit error
			expect(decodeBch(bad).data).toBe(data & 0x7f);
		}
	});
});

describe('GSC/Golay alpha/numeric discriminate scoring', () => {
	// Nibble codes: 0-9 digits, 0xA fill, 0xB 'U', 0xC space, 0xD '-', 0xF shift.
	it('scores a pure-digit block higher as numeric than alpha', () => {
		// "123456789012" as nibbles vs the same 7 data bytes read as alpha codes.
		const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2];
		const nScore = scoreNumeric(digits, 0);
		// Those 12 nibbles pack into 7 bytes -> 8 alpha 6-bit codes; worst case the
		// alpha reading is mostly punctuation/non-chars. Numeric must win.
		expect(nScore).toBeGreaterThan(0);
		expect(nScore).toBeGreaterThan(scoreAlpha([0x0c, 0x0d, 0x3f, 0x3f], 0));
	});

	it('penalises a stray U heavily in numeric scoring', () => {
		// Leading single U (urgent) is only mildly penalised...
		const urgent = scoreNumeric([0x0b, 1, 2, 3], 0);
		// ...but a U in the middle is a strong artifact signal.
		const stray = scoreNumeric([1, 2, 0x0b, 3], 0);
		expect(urgent).toBeGreaterThan(stray);
	});

	it('rewards real letters as alpha and fill quadratically', () => {
		const letters = scoreAlpha([0x21, 0x22, 0x23], 0); // A B C (0x21='A')
		expect(letters).toBe(12); // 3 letters x +4
		expect(scoreAlpha([], 3)).toBe(18); // 2 * 3^2
	});
});

describe('GSC/Golay decodeBatch', () => {
	it('decodes a synthetic alpha batch (text + type)', () => {
		initFec();
		const bits = encodeBatch(0, 2, 0, 'HELLO');
		const msg = decodeBatch(bits, 0, true);
		expect(msg).not.toBeNull();
		expect(msg.protocol).toBe('gsc');
		expect(msg.type).toBe('alpha');
		expect(msg.text).toBe('HELLO');
		expect(msg.uncorrectableCount).toBe(0);
	});

	it('reports per-codeword charStatus (all clean on an error-free batch)', () => {
		initFec();
		const bits = encodeBatch(0, 2, 0, 'HELLO');
		const msg = decodeBatch(bits, 0, true);
		expect(msg.charStatus).toHaveLength(msg.text.length);
		expect(msg.charStatus.every((s) => s === 0)).toBe(true);
		expect(msg.errorCount).toBe(0);
	});

	it('decodes a multi-block alpha message without truncating at 8 chars', () => {
		initFec();
		const text = 'CALL 555-1234'; // 13 chars -> 2 blocks
		const bits = encodeBatch(0, 2, 0, text);
		const msg = decodeBatch(bits, 0, true);
		expect(msg.type).toBe('alpha');
		expect(msg.text).toBe(text);
	});

	it('discriminates a full 8-letter alpha block (zero fill) as alpha, not numeric', () => {
		initFec();
		// Exactly 8 letters fills one alpha block with no trailing fill, so the
		// discriminate scores purely on content; letters must out-score the
		// coincidental all-digit numeric reinterpretation.
		const bits = encodeBatch(0, 2, 0, 'ABCDEFGH');
		const msg = decodeBatch(bits, 0, true);
		expect(msg.type).toBe('alpha');
		expect(msg.text).toBe('ABCDEFGH');
	});

	it('returns null when no start code is present', () => {
		initFec();
		const noise = Array.from({ length: 600 }, (_, i) => (i * 7) & 1);
		expect(decodeBatch(noise, 0, true)).toBeNull();
	});
});

describe('GSC/Golay GSCDecoder (streaming sync)', () => {
	it('locks on the dup-encoded preamble and decodes a full transmission', () => {
		initFec();
		// Full on-air bit sequence: preamble + start code + address + data.
		const bits = encodeBatch(0, 2, 0, 'HELLO', true);
		// End of transmission: a run of constant bits (>= EOT threshold) so the
		// decoder flushes and decodes the buffered batch.
		for (let i = 0; i < 64; i++) bits.push(0);

		// Modulate to 48 kHz FM-discriminator-style samples: mark (bit 1) =
		// negative deviation, space (bit 0) = positive, matching the slicer.
		const SPB = 80; // 48000 / 600
		const samples = new Float32Array(bits.length * SPB);
		let s = 0;
		for (const bit of bits) {
			const level = bit ? -1.0 : 1.0;
			for (let k = 0; k < SPB; k++) samples[s++] = level;
		}

		const got = [];
		const dec = new GSCDecoder(48000, (m) => got.push(m));
		dec.process(samples);

		expect(got.length).toBeGreaterThanOrEqual(1);
		const msg = got[0];
		expect(msg.protocol).toBe('gsc');
		expect(msg.type).toBe('alpha');
		expect(msg.text).toBe('HELLO');
		expect(msg.preambleIndex).toBe(0);
	});

	it('locks and decodes an INVERTED-polarity transmission with a phase offset', () => {
		initFec();
		const bits = encodeBatch(0, 2, 0, 'HELLO', true);
		for (let i = 0; i < 64; i++) bits.push(1); // constant tail (inverted idle)

		const SPB = 80;
		// Prepend a fractional-bit phase offset so the codeword boundary does not
		// align to sample 0 (reproduces a real over-the-air lock point).
		const offset = 37;
		const samples = new Float32Array(offset + bits.length * SPB);
		for (let k = 0; k < offset; k++) samples[k] = 1.0;
		let s = offset;
		for (const bit of bits) {
			// INVERTED polarity: flip the mark/space sense vs the normal test.
			const level = bit ? 1.0 : -1.0;
			for (let k = 0; k < SPB; k++) samples[s++] = level;
		}

		const got = [];
		const dec = new GSCDecoder(48000, (m) => got.push(m));
		dec.process(samples);

		expect(got.length).toBeGreaterThanOrEqual(1);
		const msg = got[0];
		expect(msg.type).toBe('alpha');
		expect(msg.text).toBe('HELLO');
	});

	it('decodes a batch when the NEXT batch preamble arrives (continuous TX, no EOT)', () => {
		initFec();
		// Two back-to-back transmissions with NO idle gap between them.
		const b1 = encodeBatch(0, 2, 0, 'HELLO', true);
		const b2 = encodeBatch(0, 2, 0, 'WORLD', true);
		const bits = [...b1, ...b2];
		for (let i = 0; i < 64; i++) bits.push(0); // final EOT flushes the 2nd

		const SPB = 80;
		const samples = new Float32Array(bits.length * SPB);
		let s = 0;
		for (const bit of bits) {
			const level = bit ? -1.0 : 1.0;
			for (let k = 0; k < SPB; k++) samples[s++] = level;
		}

		const got = [];
		const dec = new GSCDecoder(48000, (m) => got.push(m));
		dec.process(samples);

		const texts = got.map((m) => m.text);
		// The first batch must decode BEFORE EOT, triggered by the 2nd preamble.
		expect(texts).toContain('HELLO');
	});

	it('emits voice START immediately and defers STOP until end of transmission', () => {
		initFec();
		const bits = encodeVoiceBatch(0, 2, 0);
		// After the voice page, the TX alerts (silence ~2 s) then the announcement
		// ends. At 48 kHz the alert window is 96000 samples; append enough silence
		// bits to drain it and then trigger the 48-bit silence stop.
		for (let i = 0; i < 2000; i++) bits.push(0);

		const SPB = 80;
		const samples = new Float32Array(bits.length * SPB);
		let s = 0;
		for (const bit of bits) {
			const level = bit ? -1.0 : 1.0;
			for (let k = 0; k < SPB; k++) samples[s++] = level;
		}

		const got = [];
		const dec = new GSCDecoder(48000, (m) => got.push(m));
		// Feed in realistic buffer-sized chunks so the sample-based voice alert
		// wait drains across process() calls, as in live streaming.
		for (let off = 0; off < samples.length; off += 4096) {
			dec.process(samples.subarray(off, off + 4096));
		}

		const voice = got.filter((m) => m.type === 'voice');
		const events = voice.map((m) => m.voiceEvent);
		expect(events).toContain('start');
		expect(events).toContain('stop');
		// START must come before STOP, and they must not be the same emission.
		expect(events.indexOf('start')).toBeLessThan(events.indexOf('stop'));
		// The STOP must carry a reason (silence, here).
		const stop = voice.find((m) => m.voiceEvent === 'stop');
		expect(stop.voiceEndReason).toBe('silence');
	});

	it('does NOT emit voice STOP during the alert-wait window', () => {
		initFec();
		const bits = encodeVoiceBatch(0, 2, 0);
		// Only a short silence (< 2 s alert window): START fires, STOP must not.
		for (let i = 0; i < 300; i++) bits.push(0);

		const SPB = 80;
		const samples = new Float32Array(bits.length * SPB);
		let s = 0;
		for (const bit of bits) {
			const level = bit ? -1.0 : 1.0;
			for (let k = 0; k < SPB; k++) samples[s++] = level;
		}
		const got = [];
		const dec = new GSCDecoder(48000, (m) => got.push(m));
		for (let off = 0; off < samples.length; off += 4096) {
			dec.process(samples.subarray(off, off + 4096));
		}
		const events = got.filter((m) => m.type === 'voice').map((m) => m.voiceEvent);
		expect(events).toContain('start');
		expect(events).not.toContain('stop');
	});

	it('ends a voice page on the activation (stop) sequence, reason=activation', () => {
		initFec();
		const bits = encodeVoiceBatch(0, 2, 0);
		// Past the 2 s alert window (1200 bits), feed non-constant audio so the
		// silence detector does not fire, then the activation stop sequence.
		const enc = {
			bits,
			bit(x) {
				this.bits.push(x & 1);
			},
			dup(cw, n) {
				for (let i = 0; i < n; i++) {
					this.bits.push((cw >> i) & 1);
					this.bits.push((cw >> i) & 1);
				}
			},
		};
		for (let i = 0; i < 1600; i++) enc.bit(((i * 1103515245 + 12345) >>> 7) & 1); // PRNG bits, not silence
		appendActivationStop(enc);
		for (let i = 0; i < 50; i++) enc.bit(i & 1);

		const SPB = 80;
		const samples = new Float32Array(bits.length * SPB);
		let s = 0;
		for (const bit of bits) {
			const level = bit ? -1.0 : 1.0;
			for (let k = 0; k < SPB; k++) samples[s++] = level;
		}
		const got = [];
		const dec = new GSCDecoder(48000, (m) => got.push(m));
		for (let off = 0; off < samples.length; off += 4096) {
			dec.process(samples.subarray(off, off + 4096));
		}
		const voice = got.filter((m) => m.type === 'voice');
		expect(voice.map((m) => m.voiceEvent)).toContain('start');
		const stop = voice.find((m) => m.voiceEvent === 'stop');
		expect(stop).toBeDefined();
		expect(stop.voiceEndReason).toBe('activation');
	});

	it('decodes mid-stream (periodic path) and returns to sync-search without an EOT', () => {
		initFec();
		// One full batch followed by NOISY transitions (no long constant run),
		// so the EOT no-transition trigger never fires. The periodic every-46-bit
		// decode must still emit the batch and drop the lock.
		const bits = encodeBatch(0, 2, 0, 'TEST', true);
		for (let i = 0; i < 400; i++) bits.push(i & 1); // alternating noise, no EOT

		const SPB = 80;
		const samples = new Float32Array(bits.length * SPB);
		let s = 0;
		for (const bit of bits) {
			const level = bit ? -1.0 : 1.0;
			for (let k = 0; k < SPB; k++) samples[s++] = level;
		}

		const got = [];
		const dec = new GSCDecoder(48000, (m) => got.push(m));
		dec.process(samples);

		expect(got.map((m) => m.text)).toContain('TEST');
		// After emitting, the decoder must have left the locked state.
		expect(dec.getStatus().synced).toBe(false);
	});
});
